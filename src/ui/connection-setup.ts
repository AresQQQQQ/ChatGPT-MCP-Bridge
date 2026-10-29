import { open, mkdir, readFile, stat, writeFile, rename, rm, chmod } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { z } from "zod";
import { configFileTemplate, loadConfig, type BridgeConfig } from "../config.js";
import { setupTunnel, updateRuntimeKey, type SetupDependencies, type SetupInput } from "../setup/tunnel-setup.js";

export const connectionSetupInputSchema = z.object({
  tunnelId: z.string().regex(/^tunnel_[A-Za-z0-9_-]{1,128}$/u).max(135).optional(),
  runtimeKey: z.string().trim().max(4096).optional(),
}).strict();

export type ConnectionSetupInput = z.infer<typeof connectionSetupInputSchema>;

export const connectionSettingsInputSchema = z.object({
  runtimeKey: z.string().trim().max(4096).optional(),
  tunnelId: z.string().trim().regex(/^tunnel_[A-Za-z0-9_-]{1,128}$/u).optional(),
  bridgePort: z.number().int().min(1).max(65535),
  healthPort: z.number().int().min(1024).max(65535),
}).strict();
export type ConnectionSettingsInput = z.infer<typeof connectionSettingsInputSchema>;

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
  readonly hasTunnelId: boolean;
  readonly legacyTunnelIdUnknown: boolean;
  readonly tunnelConfigured: boolean;
  readonly tunnelId: string;
  readonly tunnelProfileMatchesId: boolean;
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
  const tunnelId = config?.tunnelId ?? config?.tunnel?.tunnelId ?? "";
  const hasTunnelId = Boolean(tunnelId);
  // Backward compatibility: older working profiles did not persist their Tunnel ID.
  const legacyTunnelIdUnknown = Boolean(config?.tunnel && !tunnelId && !config.tunnel.tunnelId);
  const tunnelConfigured = Boolean(config?.tunnel);
  const tunnelProfileMatchesId = Boolean(config?.tunnel && (legacyTunnelIdUnknown || (Boolean(config.tunnel.tunnelId) && Boolean(tunnelId) && config.tunnel.tunnelId === tunnelId)));
  const missingItems: string[] = [];
  if (!hasRuntimeKey) missingItems.push("Runtime API key");
  if (!hasTunnelId && !tunnelConfigured) missingItems.push("Tunnel ID");
  if (!tunnelConfigured) missingItems.push("Tunnel profile 尚未初始化");
  else if (!tunnelProfileMatchesId) missingItems.push("Tunnel profile 与当前 Tunnel ID 不一致，需要重新初始化");
  else if (!tunnelProfileAvailable) missingItems.push("Tunnel profile 目录");
  else if (!tunnelClientAvailable) missingItems.push("Tunnel Client 文件");
  const ready = rawConfig !== undefined && !configurationError && hasRuntimeKey &&
    tunnelConfigured && tunnelProfileMatchesId && tunnelProfileAvailable && tunnelClientAvailable;

  return {
    ...progress,
    configExists: rawConfig !== undefined,
    configurationError,
    hasBridgeAuth,
    hasRuntimeKey,
    hasTunnelId,
    legacyTunnelIdUnknown,
    tunnelConfigured,
    tunnelId,
    tunnelProfileMatchesId,
    tunnelClientAvailable,
    tunnelProfileAvailable,
    defaultHealthPort: config?.tunnelHealthPort ?? (config?.tunnel?.healthUrl ? portFromHealthUrl(config.tunnel.healthUrl) : 8080),
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


async function persistApiPortSettings(
  configPath: string,
  originalConfig: string | undefined,
  nextConfig: string,
  envPath: string,
  oldEnv: string | undefined,
  nextEnv: string,
): Promise<void> {
  const nonce = String(process.pid) + "." + randomUUID();
  const configTemp = configPath + ".settings." + nonce + ".tmp";
  const envTemp = envPath + ".settings." + nonce + ".tmp";
  try {
    await writeFile(configTemp, nextConfig, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(envTemp, nextEnv, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (await readOptional(configPath) !== originalConfig || await readOptional(envPath) !== oldEnv) {
      throw new Error("配置在保存期间被修改，请刷新设置后重试；原配置未覆盖。");
    }
    await rename(envTemp, envPath);
    try { await rename(configTemp, configPath); }
    catch (error) {
      const currentEnv = await readOptional(envPath);
      if (currentEnv === nextEnv) {
        if (oldEnv === undefined) await rm(envPath, { force: true });
        else await writeFile(envPath, oldEnv, { encoding: "utf8", mode: 0o600 });
      }
      // Never delete a config file that may have appeared concurrently.
      throw error;
    }
    await chmod(configPath, 0o600).catch(() => undefined);
    await chmod(envPath, 0o600).catch(() => undefined);
  } finally {
    await rm(configTemp, { force: true }).catch(() => undefined);
    await rm(envTemp, { force: true }).catch(() => undefined);
  }
}

export async function saveConnectionSettings(
  configPath: string,
  value: unknown,
  options: { progress?: (message: string) => void } = {},
): Promise<void> {
  const parsed = connectionSettingsInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("请检查 Runtime API key、Tunnel ID、Bridge 端口和健康检查端口。");
  const input = parsed.data;
  const absolute = path.resolve(configPath);
  const originalConfig = await readOptional(absolute);
  const existing = await assertBridgeStopped(absolute);
  const bridgePort = input.bridgePort;
  const healthPort = input.healthPort;
  if (bridgePort === healthPort) throw new Error("健康检查端口不能与 Bridge 端口相同。");
  if (bridgePort !== (existing?.port ?? 3000)) await assertPortAvailable(bridgePort);

  const envPath = path.join(path.dirname(absolute), ".env");
  const oldEnv = await readOptional(envPath);
  const oldKey = parseEnv(oldEnv ?? "").CONTROL_PLANE_API_KEY;
  const suppliedKey = input.runtimeKey?.trim() ?? "";
  const nextKey = suppliedKey || oldKey || "";
  const nextEnv = nextKey ? updateRuntimeKey(oldEnv ?? "", nextKey) : oldEnv ?? "";

  const existingTunnelId = existing?.tunnelId ?? existing?.tunnel?.tunnelId ?? "";
  const desiredTunnelId = input.tunnelId?.trim() || existingTunnelId;
  const tunnel = existing?.tunnel;
  const oldHealthPort = portFromHealthUrl(tunnel?.healthUrl);
  const portsChanged = bridgePort !== (existing?.port ?? 3000) ||
    (Boolean(tunnel) && healthPort !== oldHealthPort);
  const tunnelIdChanged = Boolean(tunnel) && desiredTunnelId !== (tunnel?.tunnelId ?? "");
  if (!tunnel || healthPort !== oldHealthPort) await assertPortAvailable(healthPort);

  // When no profile exists, persist settings first so the wizard can initialize it on the next step.
  // Changes to an existing profile ID or endpoint are initialized transactionally before switching config.
  if (tunnel && (portsChanged || tunnelIdChanged)) {
    if (!desiredTunnelId) throw new Error("请先填写 Tunnel ID，再修改已初始化 Tunnel 的连接参数。");
    if (!nextKey) throw new Error("重新初始化 Tunnel 前必须先在设置中保存 Runtime API key。");
    await setupTunnel({
      configPath: absolute,
      tunnelId: desiredTunnelId,
      ...(suppliedKey ? { runtimeKey: suppliedKey } : {}),
      healthPort,
      bridgePort,
      reuseClient: true,
    }, options.progress ? { progress: options.progress } : {});
    return;
  }

  const raw = JSON.parse(originalConfig ?? configFileTemplate()) as Record<string, unknown>;
  raw.port = bridgePort;
  raw.tunnelHealthPort = healthPort;
  if (desiredTunnelId) raw.tunnelId = desiredTunnelId;
  await persistApiPortSettings(
    absolute,
    originalConfig,
    JSON.stringify(raw, null, 2) + "\n",
    envPath,
    oldEnv,
    nextEnv,
  );
}

export async function runConnectionSetup(
  configPath: string,
  value: unknown,
  onProgress: (message: string) => void,
  dependencies: SetupDependencies = {},
): Promise<void> {
  const parsed = connectionSetupInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("请检查 Tunnel ID 和 Runtime API key。");
  const input = parsed.data;
  const before = await readConnectionSetupStatus(configPath);
  if (before.configurationError) throw new Error(before.configurationError);
  const tunnelId = input.tunnelId?.trim() || before.tunnelId;
  const runtimeKey = input.runtimeKey?.trim() ?? "";
  if (!tunnelId) throw new Error("请先在连接向导中填写 Tunnel ID，或前往设置保存。");
  if (!runtimeKey && !before.hasRuntimeKey) throw new Error("请先在连接向导中填写 Runtime API key，或前往设置保存。");

  onProgress("正在保存统一连接配置…");
  await saveConnectionSettings(configPath, {
    ...(runtimeKey ? { runtimeKey } : {}),
    tunnelId,
    bridgePort: before.bridgePort,
    healthPort: before.defaultHealthPort,
  }, { progress: onProgress });
  onProgress("连接参数已保存，正在准备 Tunnel profile…");

  const afterSave = await readConnectionSetupStatus(configPath);
  if (afterSave.ready) {
    onProgress("连接配置与 Tunnel profile 已同步。");
    return;
  }
  if (afterSave.configurationError) throw new Error(afterSave.configurationError);
  const setupInput: SetupInput = {
    configPath: path.resolve(configPath),
    tunnelId,
    ...(runtimeKey ? { runtimeKey } : {}),
    healthPort: afterSave.defaultHealthPort,
    bridgePort: afterSave.bridgePort,
    reuseClient: afterSave.reuseClientDefault,
  };
  await setupTunnel(setupInput, {
    ...dependencies,
    progress: message => onProgress(message),
  });
}
