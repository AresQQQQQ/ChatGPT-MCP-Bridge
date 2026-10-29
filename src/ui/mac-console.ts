import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import express from "express";
import { z } from "zod";

import { BridgeController } from "../control/bridge-controller.js";
import { readWorkspaceConfig, writeWorkspaceConfig } from "./workspace-config.js";
import { ensureUiBootstrapConfig, readConnectionSetupStatus, runConnectionSetup, saveConnectionSettings, connectionSettingsInputSchema, connectionSetupInputSchema, type ConnectionSetupProgress } from "./connection-setup.js";

const exec = promisify(execFile);
const ASSET_ROOT = fileURLToPath(new URL("../../assets/", import.meta.url));
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).max(128);
const workspace = z.object({ originalId: id.optional(), id, root: z.string().min(1).max(4096), mode: z.enum(["readonly", "workspace", "trusted-dev", "handoff"]) }).strict();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "stop", "restart", "close"]) }).strict(),
  z.object({ action: z.literal("connection-setup"), input: connectionSetupInputSchema }).strict(),
  z.object({ action: z.literal("save-api-port-settings"), input: connectionSettingsInputSchema }).strict(),
  z.object({ action: z.literal("save-config"), revision: z.string().regex(/^[a-f0-9]{64}$/u), workspaces: z.array(workspace).min(1).max(100) }).strict(),
  z.object({ action: z.literal("refresh-codex"), workspaceId: id }).strict(),
  z.object({ action: z.literal("unbind-codex"), workspaceId: id, moduleId: id }).strict(),
  z.object({ action: z.enum(["local-mcp-load", "local-mcp-unload", "local-mcp-probe"]), workspaceId: id, serverId: id }).strict(),
]);

type Controller = Pick<BridgeController, "lifecycleState" | "start" | "stop" | "getStatus" | "getLogs" | "getCodexStatus" | "getCodexModuleBindings" | "getLocalMcpServers" | "loadLocalMcpServer" | "unloadLocalMcpServer" | "probeLocalMcpServer" | "unbindCodexModule">;
export interface MacControlUiOptions {
  readonly openBrowser?: boolean;
  readonly controller?: Controller;
  readonly launchBrowser?: (url: string) => Promise<void>;
}
export interface MacControlUi { readonly url: string; close(): Promise<void> }

function revision(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function launchMacControlUi(configPath: string, options: MacControlUiOptions = {}): Promise<MacControlUi> {
  configPath = path.resolve(configPath);
  await ensureUiBootstrapConfig(configPath);
  // Validate the bootstrapped or existing config before opening the console.
  await readWorkspaceConfig(configPath);
  const controller = options.controller ?? new BridgeController({ configPath, captureTunnelOutput: true });
  const credential = randomBytes(32).toString("hex");
  const secrets = new Set<string>([credential]);
  let operation: Promise<void> | undefined;
  let connectionSetupState: ConnectionSetupProgress = { running: false, success: false, progress: "等待配置", error: "" };
  let closing: Promise<void> | undefined;
  let closed = false;
  let origin = "";
  const app = express();
  app.disable("x-powered-by");
  const server = http.createServer(app);

  const refreshSecrets = async (rawConfig: string): Promise<void> => {
    const config = JSON.parse(rawConfig) as { auth?: { token?: string } };
    if (config.auth?.token) secrets.add(config.auth.token);
    try {
      const env = parseEnv(await readFile(path.join(path.dirname(configPath), ".env"), "utf8"));
      if (env.CONTROL_PLANE_API_KEY) secrets.add(env.CONTROL_PLANE_API_KEY);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  function redact(text: string): string {
    for (const secret of secrets) text = text.split(secret).join("[已隐藏]");
    return text.replace(/tunnel_[A-Za-z0-9_-]+/gu, "[Tunnel ID 已隐藏]");
  }
  function sanitize<T>(value: T): T {
    if (typeof value === "string") return redact(value) as T;
    if (Array.isArray(value)) return value.map(item => sanitize(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)])) as T;
    return value;
  }
  function safeLogs() {
    const logs = controller.getLogs();
    const combined = logs.map(log => log.message).join("");
    const spans: Array<{ start: number; end: number }> = [];
    for (const secret of secrets) {
      let start = combined.indexOf(secret);
      while (start >= 0) { spans.push({ start, end: start + secret.length }); start = combined.indexOf(secret, start + secret.length); }
    }
    for (const match of combined.matchAll(/tunnel_[A-Za-z0-9_-]+/gu)) spans.push({ start: match.index, end: match.index + match[0].length });
    let offset = 0;
    return logs.map(log => {
      const start = offset, end = offset + log.message.length; offset = end;
      const splitSecret = spans.some(span => span.start < end && span.end > start && (span.start < start || span.end > end));
      return splitSecret ? { ...log, message: "[分段输出中的鉴权内容已隐藏]" } : log;
    });
  }
  await refreshSecrets(await readFile(configPath, "utf8"));

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Finish the current start/save before stopping, so a late completion cannot orphan services.
      if (operation) await operation.catch(() => undefined);
      try { await controller.stop(); }
      finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        secrets.clear();
      }
    })();
    return closing;
  };

  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.headers.host !== new URL(origin).host) { res.status(403).json({ error: "控制台仅接受本机地址" }); return; }
    if (closed) { res.status(410).json({ error: "控制台已关闭" }); return; }
    next();
  });
  app.use("/api", (req, res, next) => {
    if (!matches(req.headers.authorization ?? "", `Bearer ${credential}`)) { res.status(401).json({ error: "控制台会话已过期，请重新运行 bridge-ui.command" }); return; }
    if ((req.method !== "GET" && req.headers.origin !== origin) || (req.headers.origin && req.headers.origin !== origin)) { res.status(403).json({ error: "拒绝来自其他页面的控制请求" }); return; }
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));
  const assets = new Map<string, readonly [string, string]>([
    ["/", ["mac-console/index.html", "text/html"]],
    ["/ui.css", ["mac-console/ui.css", "text/css"]],
    ["/ui.js", ["mac-console/ui.js", "text/javascript"]],
    ...["chatgpt-mcp-bridge", "chatgpt", "secure-tunnel", "mcp", "mcp-bridge", "codex-desktop"].map(name => [`/icons/${name}.png`, [`icons/${name}.png`, "image/png"]] as const),
  ]);
  for (const [route, asset] of assets) {
    if (!asset) continue;
    const [file, type] = asset;
    app.get(route, async (_req, res) => { res.type(type!).send(await readFile(path.join(ASSET_ROOT, file!))); });
  }
  app.get("/api/snapshot", async (_req, res) => {
    const config = await readWorkspaceConfig(configPath);
    await refreshSecrets(await readFile(configPath, "utf8"));
    const status = await controller.getStatus();
    const codexStatus = await controller.getCodexStatus().catch(() => ({ enabled: false, available: false, ipcConnected: false }));
    const bindings = status.state === "running"
      ? (await Promise.all(config.workspaces.map(item => controller.getCodexModuleBindings(item.id).catch(() => [])))).flat()
      : [];
    const connectionSetup = await readConnectionSetupStatus(configPath, connectionSetupState);
    const snapshot = sanitize({ status, logs: safeLogs(), workspaces: config.workspaces, codexDefaults: config.codexDefaults, revision: revision(config.key), codexStatus, codexBindings: bindings, localMcpServers: await controller.getLocalMcpServers(), connectionSetup, busy: !!operation });
    // Tunnel ID is a non-secret identifier needed by the local settings UI; keep log redaction intact.
    res.json({ ...snapshot, connectionSetup: { ...snapshot.connectionSetup, tunnelId: connectionSetup.tunnelId } });
  });
  app.post("/api/action", async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "控制请求参数无效" }); return; }
    const input = parsed.data;
    if (input.action === "close") {
      res.json({ ok: true });
      // The response must finish before its own HTTP listener is closed.
      res.once("finish", () => { void close().catch(() => { process.exitCode = 1; }); });
      return;
    }
    if (operation) { res.status(409).json({ error: "正在执行操作，请稍后重试" }); return; }
    if (input.action === "connection-setup" && controller.lifecycleState !== "stopped") { res.status(409).json({ error: "请先停止 Bridge，再配置连接。" }); return; }
    if (input.action === "save-api-port-settings" && controller.lifecycleState !== "stopped") { res.status(409).json({ error: "请先停止 Bridge，再保存连接设置。" }); return; }
    if (input.action === "save-config" && controller.lifecycleState !== "stopped") {
      res.status(409).json({ error: "请先停止 Bridge 再保存配置" }); return;
    }
    const task = (async () => {
      if (input.action === "connection-setup") {
        const runtimeKey = input.input.runtimeKey?.trim() ?? "";
        let persisted = false;
        let parametersSaved = false;
        if (runtimeKey) secrets.add(runtimeKey);
        connectionSetupState = { running: true, success: false, progress: "正在保存统一连接配置…", error: "" };
        try {
          await runConnectionSetup(configPath, input.input, message => {
            const safe = redact(message);
            if (safe.includes("连接参数已保存")) parametersSaved = true;
            connectionSetupState = { running: true, success: false, progress: safe, error: "" };
          });
          await refreshSecrets(await readFile(configPath, "utf8"));
          persisted = true;
          connectionSetupState = { running: false, success: true, progress: "连接配置已保存，可以启动 Bridge。", error: "" };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : "连接配置失败。");
          if (parametersSaved) persisted = true;
          connectionSetupState = { running: false, success: false, progress: parametersSaved ? "连接参数已保存，连接初始化未完成" : "连接配置未完成", error: message };
          throw new Error(message);
        } finally {
          if (runtimeKey && !persisted) secrets.delete(runtimeKey);
        }
      } else if (input.action === "save-api-port-settings") {
        const runtimeKey = input.input.runtimeKey?.trim() ?? "";
        let persisted = false;
        if (runtimeKey) secrets.add(runtimeKey);
        connectionSetupState = { running: true, success: false, progress: "正在保存连接设置…", error: "" };
        try {
          await saveConnectionSettings(configPath, input.input, { progress: message => {
            connectionSetupState = { running: true, success: false, progress: redact(message), error: "" };
          } });
          persisted = true;
          await refreshSecrets(await readFile(configPath, "utf8"));
          connectionSetupState = { running: false, success: false, progress: "设置已保存", error: "" };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : "保存连接设置失败。");
          connectionSetupState = { running: false, success: false, progress: "设置未完成", error: message };
          throw new Error(message);
        } finally {
          if (runtimeKey && !persisted) secrets.delete(runtimeKey);
        }
      } else if (input.action === "start") await controller.start();
      else if (input.action === "stop") await controller.stop();
      else if (input.action === "restart") { await controller.stop(); await controller.start(); }
      else if (input.action === "save-config") {
        const config = await readWorkspaceConfig(configPath);
        if (revision(config.key) !== input.revision) throw new Error("配置已被其他程序修改，请重新载入");
        await writeWorkspaceConfig(configPath, input.workspaces.map(item => ({ id: item.id, root: item.root, mode: item.mode, ...(item.originalId ? { originalId: item.originalId } : {}) })), { expectedKey: config.key });
      } else if (input.action === "refresh-codex") await controller.getCodexModuleBindings(input.workspaceId, true);
      else if (input.action === "unbind-codex") await controller.unbindCodexModule(input.workspaceId, input.moduleId);
      else if (input.action === "local-mcp-load") await controller.loadLocalMcpServer(input.workspaceId, input.serverId);
      else if (input.action === "local-mcp-unload") await controller.unloadLocalMcpServer(input.workspaceId, input.serverId);
      else if (input.action === "local-mcp-probe") await controller.probeLocalMcpServer(input.workspaceId, input.serverId);
    })();
    operation = task;
    try { await task; res.json({ ok: true }); }
    catch (error) { res.status(error instanceof Error && error.message.includes("其他程序修改") ? 409 : 400).json({ error: redact(error instanceof Error ? error.message : "操作失败") }); }
    finally { if (operation === task) operation = undefined; }
  });
  app.use((_req, res) => { res.status(404).json({ error: "页面不存在" }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : 400).json({ error: redact(error instanceof Error ? error.message : "控制台请求失败") });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法创建本机控制台");
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/#${credential}`;
  if (options.openBrowser !== false) {
    try { await (options.launchBrowser ?? (async target => { await exec("/usr/bin/open", [target], { shell: false }); }))(url); }
    catch { await close(); throw new Error("无法打开浏览器，请检查 macOS 默认浏览器设置"); }
  }
  return { url, close };
}
