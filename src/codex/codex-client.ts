import { spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { DefaultProcessTreeTerminator } from "../commands/process-tree.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARS = 1_000;

export type JsonObject = Record<string, unknown>;
export type CodexNotificationListener = (method: string, params: unknown) => void;

export interface CodexClientOptions {
  readonly clientPath?: string;
  readonly requestTimeoutMs?: number;
  readonly onStderr?: (text: string) => void;
}

export interface CodexRpcClient {
  request<T = unknown>(method: string, params?: JsonObject): Promise<T>;
  notify(method: string, params?: JsonObject): Promise<void>;
  onNotification(listener: CodexNotificationListener): () => void;
  close(): Promise<void>;
}

export class CodexBridgeError extends Error {
  public readonly code: number | undefined;

  public constructor(message: string, code?: number) {
    super(message);
    this.name = "CodexBridgeError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface CodexLaunchSpec {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeErrorText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = raw
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "<redacted>")
    .replace(/[\r\n\t\0]+/gu, " ")
    .trim();
  return redacted.length <= MAX_ERROR_CHARS ? redacted : `${redacted.slice(0, MAX_ERROR_CHARS)}…`;
}

async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function pathEntries(): readonly string[] {
  const raw = process.platform === "win32"
    ? (process.env.Path ?? process.env.PATH ?? "")
    : (process.env.PATH ?? process.env.Path ?? "");
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of raw.split(path.delimiter)) {
    if (!value || !path.isAbsolute(value)) continue;
    const normalized = path.normalize(value);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(normalized);
  }
  return entries;
}

async function resolveCandidate(candidate: string): Promise<CodexLaunchSpec | undefined> {
  const absolute = path.resolve(candidate);
  if (!await isRegularFile(absolute)) return undefined;
  const lower = absolute.toLowerCase();
  if (/\.(?:js|cjs|mjs)$/u.test(lower)) {
    return { executable: process.execPath, prefixArgs: [absolute] };
  }
  if (process.platform === "win32" && lower.endsWith(".cmd")) {
    const script = path.join(path.dirname(absolute), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (await isRegularFile(script)) {
      return { executable: process.execPath, prefixArgs: [script] };
    }
    return undefined;
  }
  return { executable: absolute, prefixArgs: [] };
}

async function desktopRuntimeCandidates(): Promise<readonly string[]> {
  if (process.platform !== "win32") return [];
  const candidates: string[] = [];
  const userProfile = process.env.USERPROFILE;
  if (userProfile && path.isAbsolute(userProfile)) {
    candidates.push(path.join(userProfile, ".codex", "plugins", ".plugin-appserver", "codex.exe"));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && path.isAbsolute(localAppData)) {
    const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    candidates.push(path.join(binRoot, "codex.exe"));
    const entries = await readdir(binRoot, { withFileTypes: true }).catch(() => []);
    const discovered = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = path.join(binRoot, entry.name, "codex.exe");
        try {
          const metadata = await stat(candidate);
          return metadata.isFile() ? { candidate, mtimeMs: metadata.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      }));
    for (const entry of discovered
      .filter((value): value is { candidate: string; mtimeMs: number } => value !== undefined)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)) {
      candidates.push(entry.candidate);
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = path.normalize(candidate).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export async function resolveCodexLaunch(clientPath?: string): Promise<CodexLaunchSpec> {
  if (clientPath) {
    if (!path.isAbsolute(clientPath)) throw new CodexBridgeError("Configured Codex client path must be absolute");
    const configured = await resolveCandidate(clientPath);
    if (!configured) throw new CodexBridgeError("Configured Codex client could not be resolved safely");
    return configured;
  }

  if (process.platform === "win32") {
    for (const candidate of await desktopRuntimeCandidates()) {
      const resolved = await resolveCandidate(candidate);
      if (resolved) return resolved;
    }
  }

  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const directory of pathEntries()) {
    for (const name of names) {
      const resolved = await resolveCandidate(path.join(directory, name));
      if (resolved) return resolved;
    }
  }
  throw new CodexBridgeError("Codex runtime was not found; configure codex.clientPath or make Codex Desktop/CLI available");
}

function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.MCP_EXTRA_HEADERS;
  delete env.MCP_DISCOVERY_EXTRA_HEADERS;
  env.RUST_LOG = env.RUST_LOG ?? "warn";
  return env;
}

export class CodexAppServerClient implements CodexRpcClient {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<CodexNotificationListener>();
  private readonly timeoutMs: number;
  private closing = false;

  public constructor(private readonly options: CodexClientOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public async request<T = unknown>(method: string, params: JsonObject = {}): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  public async notify(method: string, params: JsonObject = {}): Promise<void> {
    await this.ensureStarted();
    this.writeMessage({ method, params });
  }

  public onNotification(listener: CodexNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return this.starting;
    const starting = this.start();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async start(): Promise<void> {
    this.closing = false;
    const spec = await resolveCodexLaunch(this.options.clientPath);
    const child = spawn(spec.executable, [...spec.prefixArgs, "app-server", "--listen", "stdio://"], {
      env: codexChildEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(new CodexBridgeError(`Codex app-server could not start: ${sanitizeErrorText(error)}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr || !child.stdin) {
      throw new CodexBridgeError("Codex app-server did not expose stdio pipes");
    }
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    stderr.on("data", (chunk: string) => this.options.onStderr?.(chunk));
    child.once("exit", (code, signal) => this.handleExit(code, signal));

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "chatgpt_mcp_bridge",
        title: "ChatGPT MCP Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.writeMessage({ method: "initialized", params: {} });
  }

  private sendRequest<T = unknown>(method: string, params: JsonObject): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexBridgeError(`Codex request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.writeMessage({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new CodexBridgeError("Codex request could not be sent"));
      }
    });
  }

  private writeMessage(message: JsonObject): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new CodexBridgeError("Codex app-server is not writable");
    stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    const id = typeof message.id === "number" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id !== undefined && ("result" in message || "error" in message) && method === undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in message && isRecord(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : undefined;
        const errorMessage = sanitizeErrorText(message.error.message ?? "Codex request failed");
        pending.reject(new CodexBridgeError(errorMessage, code));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id !== undefined && method) {
      this.writeMessage({
        id,
        error: {
          code: -32601,
          message: "ChatGPT MCP Bridge does not handle interactive Codex client requests in this version",
        },
      });
      return;
    }

    if (method) {
      for (const listener of this.listeners) listener(method, message.params);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasClosing = this.closing;
    this.child = undefined;
    const error = new CodexBridgeError(
      wasClosing ? "Codex app-server stopped" : `Codex app-server stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`})`,
    );
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!wasClosing) {
      for (const listener of this.listeners) listener("bridge/codex/closed", { code, signal });
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CodexBridgeError("Codex app-server is shutting down"));
      this.pending.delete(id);
    }
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedGracefully = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (exited: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(exited);
        };
        const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), 1_000);
        timer.unref();
        child.once("exit", () => finish(true));
      });
      if (!exitedGracefully && child.exitCode === null && child.signalCode === null) {
        const terminator = new DefaultProcessTreeTerminator();
        await terminator.terminate(child, "shutdown", 1_500).catch(() => undefined);
      }
    }
  }
}
