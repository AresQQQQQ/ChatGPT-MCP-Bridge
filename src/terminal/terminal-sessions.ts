import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IPty, IDisposable } from "node-pty";

import { resolveCommandCwd } from "../commands/command-planner.js";
import { trustedDeveloperEnvironment } from "../commands/dev-execution.js";
import { promptForLocalPassword } from "./local-password-prompt.js";

const MAX_SESSIONS = 6;
const MAX_WORKSPACE_SESSIONS = 4;
const MAX_INPUT_CHARS = 4096;
const MAX_BUFFER_CHARS = 256 * 1024;
const MAX_READ_CHARS = 32 * 1024;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const LIFETIME_MS = 60 * 60_000;
const EXIT_RETENTION_MS = 5 * 60_000;
const PASSWORD_PROMPT_TTL_MS = 90_000;

export class TerminalSessionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TerminalSessionError";
  }
}

type PtyHandle = Pick<IPty, "pid" | "onData" | "onExit" | "write" | "kill">;
export type PtySpawner = (executable: string, args: string[], options: {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<PtyHandle>;

export type LocalPasswordPrompt = (label: string) => Promise<string | null>;

export interface StartTerminalRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface TerminalView {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly executable: string;
  readonly pid: number;
  readonly state: "running" | "closing" | "exited";
  readonly createdAt: string;
  readonly lastAccessAt: string;
  readonly exitCode: number | null;
}

export interface TerminalReadResult extends TerminalView {
  readonly output: string;
  readonly nextCursor: number;
  readonly truncated: boolean;
}

interface TerminalSession {
  readonly workspaceId: string;
  readonly id: string;
  readonly executable: string;
  readonly terminal: PtyHandle;
  readonly createdAt: number;
  lastAccessAt: number;
  lastOutputAt: number;
  output: string;
  baseCursor: number;
  endCursor: number;
  exited: boolean;
  closing: boolean;
  exitedAt?: number;
  closingAt?: number;
  exitCode: number | null;
  pendingPassword: boolean;
  readonly listeners: Set<() => void>;
  readonly disposables: IDisposable[];
}

async function spawnPty(
  executable: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
): Promise<PtyHandle> {
  const pty = await import("node-pty");
  return pty.spawn(executable, args, options);
}

function assertCommand(request: StartTerminalRequest): void {
  if (!request.executable || request.executable.length > 4096 || /[\u0000\r\n]/u.test(request.executable)) {
    throw new TerminalSessionError("Invalid terminal executable");
  }
  const args = request.args ?? [];
  if (args.length > 128 || args.some((value) => value.length > 16 * 1024 || value.includes("\u0000"))) {
    throw new TerminalSessionError("Invalid terminal arguments");
  }
  if (args.reduce((sum, value) => sum + value.length, 0) > 128 * 1024) {
    throw new TerminalSessionError("Terminal arguments exceed the allowed size");
  }
  if (request.cols !== undefined && (!Number.isInteger(request.cols) || request.cols < 20 || request.cols > 300)) {
    throw new TerminalSessionError("cols must be between 20 and 300");
  }
  if (request.rows !== undefined && (!Number.isInteger(request.rows) || request.rows < 5 || request.rows > 100)) {
    throw new TerminalSessionError("rows must be between 5 and 100");
  }
}

function wake(session: TerminalSession): void {
  for (const listener of session.listeners) listener();
  session.listeners.clear();
}

function view(session: TerminalSession): TerminalView {
  return {
    workspaceId: session.workspaceId,
    sessionId: session.id,
    executable: session.executable,
    pid: session.terminal.pid,
    state: session.exited ? "exited" : session.closing ? "closing" : "running",
    createdAt: new Date(session.createdAt).toISOString(),
    lastAccessAt: new Date(session.lastAccessAt).toISOString(),
    exitCode: session.exitCode,
  };
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly pendingPerWorkspace = new Map<string, number>();
  private pendingTotal = 0;
  private readonly cleanupTimer: NodeJS.Timeout;
  private stopped = false;

  public constructor(
    private readonly spawner: PtySpawner = spawnPty,
    private readonly localPasswordPrompt: LocalPasswordPrompt = promptForLocalPassword,
    private readonly now: () => number = Date.now,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    this.cleanupTimer.unref();
  }

  private requireSession(workspaceId: string, sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new TerminalSessionError("Terminal session not found in this workspace");
    }
    session.lastAccessAt = this.now();
    return session;
  }

  private assertRunning(session: TerminalSession): void {
    if (session.exited || session.closing) {
      throw new TerminalSessionError("Terminal session is no longer running");
    }
  }

  public async start(
    workspaceId: string,
    workspaceRoot: string,
    request: StartTerminalRequest,
  ): Promise<TerminalView> {
    if (this.stopped) throw new TerminalSessionError("Terminal manager is closed");
    this.cleanup();
    assertCommand(request);
    const active = [...this.sessions.values()].filter((session) => !session.exited && !session.closing);
    const workspaceActive = active.filter((session) => session.workspaceId === workspaceId).length;
    const workspacePending = this.pendingPerWorkspace.get(workspaceId) ?? 0;
    if (active.length + this.pendingTotal >= MAX_SESSIONS || workspaceActive + workspacePending >= MAX_WORKSPACE_SESSIONS) {
      throw new TerminalSessionError("Too many active terminal sessions");
    }
    this.pendingTotal++;
    this.pendingPerWorkspace.set(workspaceId, workspacePending + 1);
    let terminal: PtyHandle;
    try {
      const cwd = await resolveCommandCwd(workspaceRoot, request.cwd);
      terminal = await this.spawner(request.executable, [...(request.args ?? [])], {
        name: "xterm-256color",
        cols: request.cols ?? 120,
        rows: request.rows ?? 30,
        cwd,
        env: trustedDeveloperEnvironment(),
      });
    } catch {
      // Native PTY errors may include user-controlled argv or local paths.
      throw new TerminalSessionError("Unable to start PTY process; check the executable, cwd and node-pty installation");
    } finally {
      this.pendingTotal--;
      const remaining = (this.pendingPerWorkspace.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) this.pendingPerWorkspace.delete(workspaceId);
      else this.pendingPerWorkspace.set(workspaceId, remaining);
    }
    if (this.stopped) {
      terminal.kill();
      throw new TerminalSessionError("Terminal manager is closed");
    }
    const now = this.now();
    const session: TerminalSession = {
      workspaceId,
      id: randomUUID(),
      executable: request.executable,
      terminal,
      createdAt: now,
      lastAccessAt: now,
      lastOutputAt: 0,
      output: "",
      baseCursor: 0,
      endCursor: 0,
      exited: false,
      closing: false,
      exitCode: null,
      pendingPassword: false,
      listeners: new Set(),
      disposables: [],
    };
    session.disposables.push(terminal.onData((text) => {
      session.lastOutputAt = this.now();
      session.output += text;
      session.endCursor += text.length;
      if (session.output.length > MAX_BUFFER_CHARS) {
        const overflow = session.output.length - MAX_BUFFER_CHARS;
        session.output = session.output.slice(overflow);
        session.baseCursor += overflow;
      }
      wake(session);
    }));
    session.disposables.push(terminal.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitedAt = this.now();
      session.exitCode = exitCode;
      wake(session);
    }));
    this.sessions.set(session.id, session);
    return view(session);
  }

  public list(workspaceId: string): TerminalView[] {
    this.cleanup();
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map(view);
  }

  private async waitForOutput(session: TerminalSession, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0 || session.exited || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        session.listeners.delete(done);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      session.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, waitMs);
    });
  }

  public async read(
    workspaceId: string,
    sessionId: string,
    cursor?: number,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<TerminalReadResult> {
    const session = this.requireSession(workspaceId, sessionId);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new TerminalSessionError("Invalid terminal output cursor");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 5_000) {
      throw new TerminalSessionError("waitMs must be between 0 and 5000");
    }
    const startCursor = cursor ?? session.baseCursor;
    if (startCursor >= session.endCursor) await this.waitForOutput(session, waitMs, signal);
    const actualStart = Math.min(session.endCursor, Math.max(startCursor, session.baseCursor));
    const stop = Math.min(actualStart + MAX_READ_CHARS, session.endCursor);
    return {
      ...view(session),
      output: session.output.slice(actualStart - session.baseCursor, stop - session.baseCursor),
      nextCursor: stop,
      truncated: startCursor < session.baseCursor,
    };
  }

  public write(workspaceId: string, sessionId: string, input: string): { readonly written: true } {
    const session = this.requireSession(workspaceId, sessionId);
    this.assertRunning(session);
    if (!input || input.length > MAX_INPUT_CHARS || input.includes("\u0000")) {
      throw new TerminalSessionError("Terminal input must be between 1 and 4096 characters");
    }
    try {
      session.terminal.write(input);
    } catch {
      throw new TerminalSessionError("Terminal input failed");
    }
    return { written: true };
  }

  public async localPassword(workspaceId: string, sessionId: string): Promise<{ readonly submitted: boolean }> {
    const session = this.requireSession(workspaceId, sessionId);
    this.assertRunning(session);
    if (!["ssh", "ssh.exe"].includes(path.win32.basename(session.executable).toLowerCase())) {
      throw new TerminalSessionError("Local password entry is supported only for an ssh client process");
    }
    // Do not send a password into a shell if the user is already logged in.
    const visibleTail = session.output.slice(-1024)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "");
    if (!/(?:password|passphrase)[^\r\n]{0,100}[:：]\s*$/iu.test(visibleTail)
      || this.now() - session.lastOutputAt > PASSWORD_PROMPT_TTL_MS) {
      throw new TerminalSessionError("No recent SSH password prompt detected; local password was not requested");
    }
    if (session.pendingPassword) throw new TerminalSessionError("Password prompt is already open");
    session.pendingPassword = true;
    try {
      const password = await this.localPasswordPrompt("SSH 密码 - " + session.workspaceId);
      if (password === null) return { submitted: false };
      if (!password || password.length > MAX_INPUT_CHARS || /[\r\n\u0000]/u.test(password)) {
        throw new TerminalSessionError("Invalid local password input");
      }
      this.assertRunning(session);
      session.terminal.write(password + "\r");
      return { submitted: true };
    } finally {
      session.pendingPassword = false;
    }
  }

  public closeSession(workspaceId: string, sessionId: string): TerminalView {
    const session = this.requireSession(workspaceId, sessionId);
    if (!session.exited && !session.closing) {
      session.closing = true;
      session.closingAt = this.now();
      try {
        session.terminal.kill();
      } catch {
        session.exited = true;
        session.exitedAt = this.now();
      }
      wake(session);
    }
    return view(session);
  }

  private disposeSession(session: TerminalSession): void {
    if (!session.exited && !session.closing) {
      session.closing = true;
      try { session.terminal.kill(); } catch { /* Process may already have exited. */ }
    }
    for (const disposable of session.disposables) disposable.dispose();
    wake(session);
    this.sessions.delete(session.id);
  }

  private cleanup(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (!session.exited && (now - session.lastAccessAt >= IDLE_TIMEOUT_MS || now - session.createdAt >= LIFETIME_MS)) {
        this.closeSession(session.workspaceId, session.id);
      }
      if (session.exited && now - (session.exitedAt ?? now) >= EXIT_RETENTION_MS) this.disposeSession(session);
      else if (session.closing && now - (session.closingAt ?? now) >= EXIT_RETENTION_MS) this.disposeSession(session);
    }
  }

  public close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const session of [...this.sessions.values()]) this.disposeSession(session);
  }
}
