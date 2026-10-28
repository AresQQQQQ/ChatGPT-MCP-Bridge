import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import express from "express";
import { z } from "zod";
import { loadConfig, type BridgeConfig } from "../config.js";
import { setupTunnel, type SetupDependencies, type SetupInput } from "../setup/tunnel-setup.js";

const ASSET_ROOT = fileURLToPath(new URL("../../assets/", import.meta.url));
const setupRequestSchema = z.object({
  tunnelId: z.string().regex(/^tunnel_[A-Za-z0-9_-]{1,128}$/u).max(135),
  runtimeKey: z.string().trim().max(4096),
  healthPort: z.number().int().min(1024).max(65535),
  bridgePort: z.number().int().min(1).max(65535).optional(),
  reuseClient: z.boolean(),
}).strict();

export interface SetupWizardSnapshot {
  readonly setupOnly: true;
  readonly running: boolean;
  readonly success: boolean;
  readonly progress: string;
  readonly error: string;
  readonly configExists: boolean;
  readonly tunnelConfigured: boolean;
  readonly hasRuntimeKey: boolean;
  readonly defaultHealthPort: number;
  readonly reuseClientDefault: boolean;
  readonly bridgePort: number;
  readonly configurationError: string;
}

export interface SetupWizardServerOptions {
  readonly setup?: (input: SetupInput, deps?: SetupDependencies) => Promise<void>;
  readonly setupDependencies?: SetupDependencies;
}

export interface SetupWizardServer {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  close(): Promise<void>;
}

function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function portFromHealthUrl(value: string | undefined): number {
  if (!value) return 8080;
  try { return Number(new URL(value).port) || 8080; }
  catch { return 8080; }
}

export async function readSetupWizardSnapshot(
  configPath: string,
  state: Pick<SetupWizardSnapshot, "running" | "success" | "progress" | "error">,
): Promise<SetupWizardSnapshot> {
  const absolute = path.resolve(configPath);
  let rawConfig: string | undefined;
  let config: BridgeConfig | undefined;
  let configurationError = "";
  try {
    rawConfig = await readOptional(absolute);
    if (rawConfig !== undefined) config = await loadConfig(absolute);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : "读取本机配置失败。";
  }
  let envText = "";
  try { envText = await readFile(path.join(path.dirname(absolute), ".env"), "utf8"); }
  catch (error) { if (!isMissing(error)) configurationError ||= "读取本机 Runtime API key 状态失败。"; }
  const env = parseEnv(envText);
  return {
    setupOnly: true,
    ...state,
    configExists: rawConfig !== undefined,
    tunnelConfigured: Boolean(config?.tunnel),
    hasRuntimeKey: Boolean(env.CONTROL_PLANE_API_KEY),
    defaultHealthPort: portFromHealthUrl(config?.tunnel?.healthUrl),
    reuseClientDefault: Boolean(config?.tunnel),
    bridgePort: config?.port ?? 3000,
    configurationError,
  };
}

async function assertBridgeStopped(configPath: string): Promise<BridgeConfig | undefined> {
  if (await readOptional(configPath) === undefined) return undefined;
  const config = await loadConfig(configPath);
  const host = ["0.0.0.0", "::", ""].includes(config.host) ? "127.0.0.1" : config.host;
  const authority = host.includes(":") ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${authority}:${config.port}/health`, { signal: AbortSignal.timeout(800) });
    if (response.ok) {
      const payload = await response.json().catch(() => undefined) as { ok?: unknown; service?: unknown } | undefined;
      if (payload?.ok === true && payload.service === "chatgpt-mcp-bridge") {
        throw new Error("检测到本机 Bridge 仍在运行。请先停止 Bridge，再重新配置 Tunnel；原配置未修改。");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("检测到本机 Bridge")) throw error;
  }
  return config;
}

async function assertPortAvailable(port: number): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise<void>((resolve, reject) => {
      const probe = createNetServer();
      probe.once("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "EPROTONOSUPPORT") {
          resolve();
          return;
        }
        if (code === "EADDRINUSE") {
          reject(new Error(`Bridge 端口 ${port} 已被占用，请选择其他端口。`));
          return;
        }
        if (code === "EACCES") {
          reject(new Error(`Bridge 端口 ${port} 无法绑定（可能被占用或需要管理员权限），请换一个可用端口。`));
          return;
        }
        reject(error);
      });
      probe.listen({ host, port, exclusive: true }, () => {
        probe.close(error => error ? reject(error) : resolve());
      });
    });
  }
}

export async function launchSetupWizardServer(
  configPath: string,
  options: SetupWizardServerOptions = {},
): Promise<SetupWizardServer> {
  configPath = path.resolve(configPath);
  const token = randomBytes(32).toString("hex");
  const secrets = new Set<string>([token]);
  let operation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let origin = "";
  let state: Pick<SetupWizardSnapshot, "running" | "success" | "progress" | "error"> = {
    running: false, success: false, progress: "等待配置", error: "",
  };
  const app = express();
  app.disable("x-powered-by");
  const server = http.createServer(app);

  const redact = (value: string): string => {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[已隐藏]");
    return result.replace(/tunnel_[A-Za-z0-9_-]+/gu, "[Tunnel ID 已隐藏]");
  };
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (origin && req.headers.host !== new URL(origin).host) { res.status(403).json({ error: "配置向导仅接受本机地址。" }); return; }
    if (closed) { res.status(410).json({ error: "配置向导已关闭。" }); return; }
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use("/api", (req, res, next) => {
    if (!matches(req.headers.authorization ?? "", `Bearer ${token}`)) { res.status(401).json({ error: "配置向导会话无效，请重新打开。" }); return; }
    if (req.headers.origin && req.headers.origin !== origin) {
      res.status(403).json({ error: "拒绝来自其他页面的配置请求。" }); return;
    }
    next();
  });
  const assets = new Map<string, readonly [string, string]>([
    ["/setup", ["setup-wizard/index.html", "text/html"]],
    ["/setup.css", ["setup-wizard/setup.css", "text/css"]],
    ["/setup.js", ["setup-wizard/setup.js", "text/javascript"]],
  ]);
  for (const [route, [file, type]] of assets) {
    app.get(route, async (_req, res, next) => {
      try { res.type(type).send(await readFile(path.join(ASSET_ROOT, file))); }
      catch (error) { next(error); }
    });
  }
  app.get("/api/snapshot", async (_req, res) => {
    try { res.json(await readSetupWizardSnapshot(configPath, state)); }
    catch (error) { res.status(400).json({ error: redact(error instanceof Error ? error.message : "读取配置状态失败。") }); }
  });
  app.post("/api/setup", async (req, res) => {
    const parsed = setupRequestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "请检查 Tunnel ID、Runtime API key 和健康端口。" }); return; }
    if (operation) { res.status(409).json({ error: "配置正在执行，请稍后重试。" }); return; }
    const input = parsed.data;
    if (input.runtimeKey) secrets.add(input.runtimeKey);
    const task = (async () => {
      state = { running: true, success: false, progress: "正在检查本机配置…", error: "" };
      try {
        const before = await readSetupWizardSnapshot(configPath, state);
        if (before.configurationError) throw new Error(before.configurationError);
        if (!input.runtimeKey && !before.hasRuntimeKey) throw new Error("首次配置需要填写 Runtime API key。");
        const existingConfig = await assertBridgeStopped(configPath);
        const bridgePort = input.bridgePort ?? existingConfig?.port ?? 3000;
        if (bridgePort === input.healthPort) throw new Error("健康检查端口不能与 Bridge 端口相同。");
        await assertPortAvailable(bridgePort);
        const setupInput: SetupInput = {
          configPath,
          tunnelId: input.tunnelId,
          runtimeKey: input.runtimeKey,
          healthPort: input.healthPort,
          bridgePort,
          reuseClient: input.reuseClient,
        };
        await (options.setup ?? setupTunnel)(setupInput, {
          ...options.setupDependencies,
          progress: message => { state = { running: true, success: false, progress: redact(message), error: "" }; },
        });
        state = { running: false, success: true, progress: "配置已安全保存。可以关闭此窗口并启动 Bridge。", error: "" };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : "Tunnel 配置失败。");
        state = { running: false, success: false, progress: "配置未完成", error: message };
        throw new Error(message);
      }
    })();
    operation = task;
    try { await task; res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: redact(error instanceof Error ? error.message : "Tunnel 配置失败。") }); }
    finally {
      if (input.runtimeKey) secrets.delete(input.runtimeKey);
      if (operation === task) operation = undefined;
    }
  });
  app.use((_req, res) => { res.status(404).json({ error: "页面不存在。" }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : 400).json({ error: redact(error instanceof Error ? error.message : "配置向导请求失败。") });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法创建本机配置向导。");
  origin = `http://127.0.0.1:${address.port}`;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      if (operation) await operation.catch(() => undefined);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      secrets.clear();
    })();
    return closing;
  };
  return { url: `${origin}/setup#${token}`, origin, token, close };
}