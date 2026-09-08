import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { AuthConfig, TunnelConfig } from "./config.js";
import { DefaultProcessTreeTerminator } from "./commands/process-tree.js";

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

export interface TunnelSpawnSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly options: SpawnOptions;
}

export interface ManagedTunnel {
  readonly child?: ChildProcess;
  readonly reused: boolean;
  close(): Promise<void>;
}

export type TunnelLogSink = (stream: "stdout" | "stderr", text: string) => void;

export interface LaunchTunnelOptions {
  readonly logSink?: TunnelLogSink;
}

export function buildTunnelSpawnSpec(
  config: TunnelConfig,
  auth: AuthConfig | undefined,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): TunnelSpawnSpec {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  if (auth) {
    const header = `Authorization: Bearer ${auth.token}`;
    env.MCP_EXTRA_HEADERS = header;
    env.MCP_DISCOVERY_EXTRA_HEADERS = header;
  }
  env.LOG_LEVEL = sourceEnv.LOG_LEVEL ?? "warn";
  return {
    executable: config.clientPath,
    args: ["run", "--profile", config.profile, ...(config.profileDir ? ["--profile-dir", config.profileDir] : [])],
    env,
    options: {
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "inherit",
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntilReady(healthUrl: string, child: ChildProcess): Promise<void> {
  const readyUrl = new URL("/readyz", healthUrl);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Tunnel client exited before becoming ready");
    }
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(`Tunnel client did not become ready at ${readyUrl.toString()} within ${READY_TIMEOUT_MS / 1_000}s`);
}

async function isAlreadyReady(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/readyz", healthUrl), { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function launchTunnel(
  config: TunnelConfig,
  auth?: AuthConfig,
  options: LaunchTunnelOptions = {},
): Promise<ManagedTunnel> {
  if (await isAlreadyReady(config.healthUrl)) {
    return { reused: true, close: async () => {} };
  }

  const spec = buildTunnelSpawnSpec(config, auth);
  const spawnOptions: SpawnOptions = options.logSink
    ? { ...spec.options, stdio: ["ignore", "pipe", "pipe"] }
    : spec.options;
  const child = spawn(spec.executable, spec.args, spawnOptions);
  if (options.logSink) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => options.logSink?.("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => options.logSink?.("stderr", chunk));
  }
  const terminator = new DefaultProcessTreeTerminator();
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      await terminator.terminate(child, "shutdown", 1_000);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await waitUntilReady(config.healthUrl, child);
    return { child, reused: false, close };
  } catch (error) {
    await close();
    throw error;
  }
}
