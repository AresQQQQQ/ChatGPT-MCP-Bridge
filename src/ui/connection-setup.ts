import { open, mkdir, readFile, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { configFileTemplate, loadConfig, type BridgeConfig } from "../config.js";
import { setupTunnel, type SetupDependencies, type SetupInput } from "../setup/tunnel-setup.js";

export const connectionSetupInputSchema = z.object({
  tunnelId: z.string().regex(/^tunnel_[A-Za-z0-9_-]{1,128}$/u).max(135),
  runtimeKey: z.string().trim().max(4096),
  healthPort: z.number().int().min(1024).max(65535),
  bridgePort: z.number().int().min(1).max(65535).optional(),
  reuseClient: z.boolean(),
}).strict();

export type ConnectionSetupInput = z.infer<typeof connectionSetupInputSchema>;

export interface ConnectionSetupProgress {
  readonly running: boolean;
  readonly success: boolean;
  readonly progress: string;
  readonly error: string;
}

export interface ConnectionSetupStatus extends ConnectionSetupProgress {
  readonly configExists: boolean;
  readonly configurationError: string;
  readonly hasBridgeAuth: boolean;
  readonly hasRuntimeKey: boolean;
  readonly tunnelConfigured: boolean;
  readonly tunnelClientAvailable: boolean;
  readonly tunnelProfileAvailable: boolean;
  readonly defaultHealthPort: number;
  readonly reuseClientDefault: boolean;
  readonly bridgePort: number;
  readonly ready: boolean;
  readonly missingItems: readonly string[];
}

const idleProgress: ConnectionSetupProgress = {
  running: false,
  success: false,
  progress: "等待配置",
  error: "",
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

/** Create a minimal, authenticated config only when a user explicitly opens the main UI on a new machine. */
export async function ensureUiBootstrapConfig(configPath: string): Promise<boolean> {
  const absolute = path.resolve(configPath);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const handle = await open(absolute, "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  });
  if (!handle) return false;
  try { await handle.writeFile(configFileTemplate(), "utf8"); }
  catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

function portFromHealthUrl(value: string | undefined): number {
  if (!value) return 8080;
  try { return Number(new URL(value).port) || 8080; }
  catch { return 8080; }
}

export async function readConnectionSetupStatus(
  configPath: string,
  progress: ConnectionSetupProgress = idleProgress,
): Promise<ConnectionSetupStatus> {
  const absolute = path.resolve(configPath);
  const rawConfig = await readOptional(absolute);
  let config: BridgeConfig | undefined;
  let configurationError = "";
  try {
    if (rawConfig !== undefined) config = await loadConfig(absolute);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : "读取本机 Bridge 配置失败。";
  }

  let envText = "";
  try { envText = await readFile(path.join(path.dirname(absolute), ".env"), "utf8"); }
  catch (error) { if (!isMissing(error)) configurationError ||= "读取本机 Runtime API key 状态失败。"; }
  const env = parseEnv(envText);
  let tunnelClientAvailable = false;
  let tunnelProfileAvailable = Boolean(config?.tunnel && !config.tunnel.profileDir);
  if (config?.tunnel?.profileDir) {
    try { tunnelProfileAvailable = (await stat(config.tunnel.profileDir)).isDirectory(); }
    catch { tunnelProfileAvailable = false; }
  }
  if (config?.tunnel?.clientPath) {
    try { tunnelClientAvailable = (await stat(config.tunnel.clientPath)).isFile(); }
    catch { tunnelClientAvailable = false; }
  }

  const hasBridgeAuth = Boolean(config?.auth?.token);
  const hasRuntimeKey = Boolean(env.CONTROL_PLANE_API_KEY);
  const tunnelConfigured = Boolean(config?.tunnel);
  const missingItems: string[] = [];
  if (!hasRuntimeKey) missingItems.push("Runtime API key");
  if (!tunnelConfigured) missingItems.push("Tunnel ID 与 profile");
  else if (!tunnelProfileAvailable) missingItems.push("Tunnel profile 目录");
  else if (!tunnelClientAvailable) missingItems.push("Tunnel Client 文件");
  const ready = rawConfig !== undefined && !configurationError && hasRuntimeKey && tunnelConfigured && tunnelProfileAvailable && tunnelClientAvailable;

  return {
    ...progress,
    configExists: rawConfig !== undefined,
    configurationError,
    hasBridgeAuth,
    hasRuntimeKey,
    tunnelConfigured,
    tunnelClientAvailable,
    tunnelProfileAvailable,
    defaultHealthPort: portFromHealthUrl(config?.tunnel?.healthUrl),
    reuseClientDefault: tunnelConfigured && tunnelClientAvailable,
    bridgePort: config?.port ?? 3000,
    ready,
    missingItems,
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
        throw new Error("检测到本机 Bridge 仍在运行。请先停止 Bridge，再配置连接；原配置未修改。");
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

export async function runConnectionSetup(
  configPath: string,
  value: unknown,
  onProgress: (message: string) => void,
  dependencies: SetupDependencies = {},
): Promise<void> {
  const parsed = connectionSetupInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("请检查 Tunnel ID、Runtime API key、Bridge 端口和健康检查端口。");
  const input = parsed.data;
  const before = await readConnectionSetupStatus(configPath);
  if (before.configurationError) throw new Error(before.configurationError);
  if (!input.runtimeKey && !before.hasRuntimeKey) throw new Error("首次配置需要填写 Runtime API key。");

  const existingConfig = await assertBridgeStopped(configPath);
  const bridgePort = input.bridgePort ?? existingConfig?.port ?? 3000;
  if (bridgePort === input.healthPort) throw new Error("健康检查端口不能与 Bridge 端口相同。");
  await assertPortAvailable(bridgePort);

  const setupInput: SetupInput = {
    configPath: path.resolve(configPath),
    tunnelId: input.tunnelId,
    runtimeKey: input.runtimeKey,
    healthPort: input.healthPort,
    bridgePort,
    reuseClient: input.reuseClient,
  };
  await setupTunnel(setupInput, {
    ...dependencies,
    progress: message => onProgress(message),
  });
}
