import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { isNodeError, loadConfig, type BridgeConfig } from "../config.js";
import { createBridgeApp, type BridgeHttpLogSink } from "../http/server.js";
import type { CodexModuleView } from "../codex/codex-tasks.js";
import type { LocalMcpRegistryEntry } from "../mcp/local-mcp-registry.js";
import { listLocalMcpTools } from "../mcp/local-mcp-proxy.js";
import { launchTunnel, type ManagedTunnel, type TunnelLogSink } from "../tunnel.js";

export type BridgeLifecycleState = "stopped" | "starting" | "running" | "stopping" | "error";
export type ConnectionState = "available" | "unavailable" | "connected" | "disconnected" | "error";

export interface LogEntry {
  readonly timestamp: string;
  readonly source: "bridge" | "tunnel" | "controller";
  readonly stream: "stdout" | "stderr";
  readonly message: string;
}

export interface BridgeControllerStatus {
  readonly state: BridgeLifecycleState;
  readonly bridge: "running" | "stopped" | "error";
  readonly mcp: "available" | "unavailable";
  readonly tunnel: "connected" | "disconnected" | "error";
  readonly pid?: number;
  readonly port?: number;
  readonly startedAt?: string;
  readonly error?: string;
}

export interface LocalMcpControllerView extends LocalMcpRegistryEntry {
  readonly probeStatus: "unknown" | "available" | "unavailable";
  readonly toolCount?: number;
  readonly latencyMs?: number;
  readonly lastProbedAt?: string;
  readonly probeError?: string;
}

interface LocalMcpProbeRecord {
  readonly status: "available" | "unavailable";
  readonly toolCount?: number;
  readonly latencyMs?: number;
  readonly lastProbedAt: string;
  readonly error?: string;
}

interface ListeningBridge {
  readonly url: string;
  readonly getCodexStatus?: () => Promise<{ readonly available: boolean; readonly ipcConnected: boolean }>;
  readonly getCodexModuleBindings?: (workspaceId: string, refresh?: boolean) => Promise<readonly CodexModuleView[]>;
  readonly unbindCodexModule?: (workspaceId: string, moduleId: string) => Promise<CodexModuleView>;
  readonly listLocalMcpServers: () => readonly LocalMcpRegistryEntry[];
  readonly loadLocalMcpServer: (workspaceId: string, serverId: string) => Promise<LocalMcpRegistryEntry>;
  readonly unloadLocalMcpServer: (workspaceId: string, serverId: string) => Promise<LocalMcpRegistryEntry>;
  readonly probeLocalMcpServer: (workspaceId: string, serverId: string) => Promise<{ readonly toolCount: number; readonly latencyMs: number }>;
  close(): Promise<void>;
}

export interface BridgeControllerOptions {
  readonly configPath: string;
  readonly maxLogLines?: number;
  readonly maxLogChars?: number;
  readonly captureTunnelOutput?: boolean;
  readonly onUnexpectedTunnelExit?: (message: string) => void;
}

export interface BridgeControllerDependencies {
  readonly loadConfig?: typeof loadConfig;
  readonly listenBridge?: (config: BridgeConfig, logSink?: BridgeHttpLogSink) => Promise<ListeningBridge>;
  readonly launchTunnel?: typeof launchTunnel;
  readonly loadProjectEnv?: (configPath: string) => Promise<string>;
  readonly probeMcp?: (config: BridgeConfig) => Promise<boolean>;
  readonly probeTunnel?: (config: BridgeConfig) => Promise<boolean>;
}

const DEFAULT_MAX_LOG_LINES = 500;
const DEFAULT_MAX_LOG_CHARS = 200_000;
const HEALTH_PROBE_TTL_MS = 5_000;

function localMcpKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}\u0000${serverId}`;
}

export async function listenBridge(config: BridgeConfig, logSink?: BridgeHttpLogSink): Promise<ListeningBridge> {
  const bridge = await createBridgeApp(config, { ...(logSink ? { logSink } : {}) });
  const server = http.createServer(bridge.app);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }

  let closed = false;
  return {
    url: `http://${config.host}:${config.port}${config.mcpPath}`,
    ...(bridge.codex ? {
      getCodexStatus: async () => {
        const status = await bridge.codex!.getStatus();
        return { available: status.desktop.available, ipcConnected: status.desktop.ipcConnected };
      },
      getCodexModuleBindings: async (workspaceId: string, refresh = false) => refresh
        ? bridge.codex!.listModules(workspaceId)
        : bridge.codex!.getModuleBindings(workspaceId),
      unbindCodexModule: async (workspaceId: string, moduleId: string) => bridge.codex!.unbindModule(workspaceId, moduleId),
    } : {}),
    listLocalMcpServers: () => bridge.localMcpRegistry.list(),
    loadLocalMcpServer: (workspaceId: string, serverId: string) => bridge.localMcpRegistry.load(workspaceId, serverId),
    unloadLocalMcpServer: (workspaceId: string, serverId: string) => bridge.localMcpRegistry.unload(workspaceId, serverId),
    probeLocalMcpServer: async (workspaceId: string, serverId: string) => {
      const startedAt = Date.now();
      const result = await listLocalMcpTools(
        bridge.localMcpRegistry,
        workspaceId,
        serverId,
        { requireLoaded: false },
      );
      return { toolCount: result.tools.length, latencyMs: Date.now() - startedAt };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await bridge.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export async function loadProjectEnv(configPath: string): Promise<string> {
  const envPath = path.join(path.dirname(configPath), ".env");
  let values: NodeJS.Dict<string>;
  try {
    values = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Missing ${envPath}; create it with CONTROL_PLANE_API_KEY=your_key`);
    }
    throw new Error(`Could not load ${envPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!values.CONTROL_PLANE_API_KEY) {
    throw new Error(`${envPath} must define CONTROL_PLANE_API_KEY`);
  }
  Object.assign(process.env, values);
  return envPath;
}

async function probeMcp(config: BridgeConfig): Promise<boolean> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-MCP-Bridge-Probe": "status",
  };
  if (config.auth) headers.Authorization = `Bearer ${config.auth.token}`;
  try {
    const response = await fetch(`http://${config.host}:${config.port}${config.mcpPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mcp-bridge-control-ui", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function probeTunnel(config: BridgeConfig): Promise<boolean> {
  if (!config.tunnel) return false;
  try {
    const response = await fetch(new URL("/readyz", config.tunnel.healthUrl), { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export class BridgeController {
  private state: BridgeLifecycleState = "stopped";
  private bridge: ListeningBridge | undefined;
  private tunnel: ManagedTunnel | undefined;
  private config: BridgeConfig | undefined;
  private startedAt: string | undefined;
  private lastError: string | undefined;
  private transition: Promise<void> | undefined;
  private healthProbeCache: { readonly checkedAt: number; readonly mcpReady: boolean; readonly tunnelReady: boolean } | undefined;
  private healthProbeInFlight: Promise<{ readonly mcpReady: boolean; readonly tunnelReady: boolean }> | undefined;
  private readonly logs: LogEntry[] = [];
  private readonly localMcpProbeCache = new Map<string, LocalMcpProbeRecord>();
  private logChars = 0;
  private readonly maxLogLines: number;
  private readonly maxLogChars: number;
  private readonly deps: Required<BridgeControllerDependencies>;

  public constructor(private readonly options: BridgeControllerOptions, dependencies: BridgeControllerDependencies = {}) {
    this.maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
    this.maxLogChars = options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
    this.deps = {
      loadConfig: dependencies.loadConfig ?? loadConfig,
      listenBridge: dependencies.listenBridge ?? listenBridge,
      launchTunnel: dependencies.launchTunnel ?? launchTunnel,
      loadProjectEnv: dependencies.loadProjectEnv ?? loadProjectEnv,
      probeMcp: dependencies.probeMcp ?? probeMcp,
      probeTunnel: dependencies.probeTunnel ?? probeTunnel,
    };
  }

  public get lifecycleState(): BridgeLifecycleState {
    return this.state;
  }

  public getLogs(): readonly LogEntry[] {
    return [...this.logs];
  }

  public async getCodexStatus(): Promise<{ readonly enabled: boolean; readonly available: boolean; readonly ipcConnected: boolean }> {
    if (!this.bridge?.getCodexStatus) return { enabled: false, available: false, ipcConnected: false };
    const status = await this.bridge.getCodexStatus();
    return { enabled: true, ...status };
  }

  public async getCodexModuleBindings(workspaceId: string, refresh = false): Promise<readonly CodexModuleView[]> {
    if (!this.bridge?.getCodexModuleBindings) return [];
    return this.bridge.getCodexModuleBindings(workspaceId, refresh);
  }

  public async unbindCodexModule(workspaceId: string, moduleId: string): Promise<CodexModuleView> {
    if (!this.bridge?.unbindCodexModule) throw new Error("Codex 当前未运行或此项目未启用 Codex");
    return this.bridge.unbindCodexModule(workspaceId, moduleId);
  }

  public async getLocalMcpServers(): Promise<readonly LocalMcpControllerView[]> {
    let entries: readonly LocalMcpRegistryEntry[];
    if (this.bridge) {
      entries = this.bridge.listLocalMcpServers();
    } else {
      const config = this.config ?? await this.deps.loadConfig(this.options.configPath);
      entries = config.workspaces.flatMap((workspace) => Object.entries(workspace.mcpServers ?? {}).map(
        ([serverId, server]) => ({
          workspaceId: workspace.id,
          serverId,
          url: server.url,
          loaded: false,
        }),
      ));
    }
    return entries.map((entry) => {
      const probe = this.localMcpProbeCache.get(localMcpKey(entry.workspaceId, entry.serverId));
      return {
        ...entry,
        probeStatus: probe?.status ?? "unknown",
        ...(probe?.toolCount !== undefined ? { toolCount: probe.toolCount } : {}),
        ...(probe?.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
        ...(probe ? { lastProbedAt: probe.lastProbedAt } : {}),
        ...(probe?.error ? { probeError: probe.error } : {}),
      };
    });
  }

  public async loadLocalMcpServer(workspaceId: string, serverId: string): Promise<LocalMcpRegistryEntry> {
    if (!this.bridge || this.state !== "running") throw new Error("Bridge 未运行，无法加载本地 MCP");
    const entry = await this.bridge.loadLocalMcpServer(workspaceId, serverId);
    this.addLog("controller", "stdout", `已加载本地 MCP：${workspaceId}/${serverId}`);
    return entry;
  }

  public async unloadLocalMcpServer(workspaceId: string, serverId: string): Promise<LocalMcpRegistryEntry> {
    if (!this.bridge || this.state !== "running") throw new Error("Bridge 未运行，无法卸载本地 MCP");
    const entry = await this.bridge.unloadLocalMcpServer(workspaceId, serverId);
    this.addLog("controller", "stdout", `已卸载本地 MCP：${workspaceId}/${serverId}`);
    return entry;
  }

  public async probeLocalMcpServer(workspaceId: string, serverId: string): Promise<LocalMcpControllerView> {
    if (!this.bridge || this.state !== "running") throw new Error("Bridge 未运行，无法检测本地 MCP");
    const key = localMcpKey(workspaceId, serverId);
    const checkedAt = new Date().toISOString();
    try {
      const probe = await this.bridge.probeLocalMcpServer(workspaceId, serverId);
      this.localMcpProbeCache.set(key, {
        status: "available",
        toolCount: probe.toolCount,
        latencyMs: probe.latencyMs,
        lastProbedAt: checkedAt,
      });
      this.addLog(
        "controller",
        "stdout",
        `本地 MCP 检测通过：${workspaceId}/${serverId} · ${probe.toolCount} tools · ${probe.latencyMs}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.localMcpProbeCache.set(key, {
        status: "unavailable",
        lastProbedAt: checkedAt,
        error: message,
      });
      this.addLog("controller", "stderr", `本地 MCP 检测失败：${workspaceId}/${serverId} · ${message}`);
    }
    const entries = await this.getLocalMcpServers();
    const entry = entries.find((candidate) => candidate.workspaceId === workspaceId && candidate.serverId === serverId);
    if (!entry) throw new Error("本地 MCP 配置不存在");
    return entry;
  }

  private isStartingOrRunning(): boolean {
    return this.state === "starting" || this.state === "running";
  }

  private isStopped(): boolean {
    return this.state === "stopped";
  }

  public addLog(source: LogEntry["source"], stream: LogEntry["stream"], message: string): void {
    for (const rawLine of message.replace(/\r\n/g, "\n").split("\n")) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const entry: LogEntry = { timestamp: new Date().toISOString(), source, stream, message: line };
      this.logs.push(entry);
      this.logChars += line.length;
    }
    while (this.logs.length > this.maxLogLines || this.logChars > this.maxLogChars) {
      const removed = this.logs.shift();
      if (!removed) break;
      this.logChars -= removed.message.length;
    }
  }

  public async start(): Promise<void> {
    if (this.isStartingOrRunning()) {
      if (this.transition) await this.transition;
      return;
    }
    if (this.transition) await this.transition;
    if (this.isStartingOrRunning()) return;

    this.state = "starting";
    this.lastError = undefined;
    this.healthProbeCache = undefined;
    this.localMcpProbeCache.clear();
    const transition = this.doStart();
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
  }

  private async doStart(): Promise<void> {
    let bridge: ListeningBridge | undefined;
    try {
      const envPath = await this.deps.loadProjectEnv(this.options.configPath);
      const config = await this.deps.loadConfig(this.options.configPath);
      if (!config.tunnel) throw new Error(`Config ${config.configPath} must define tunnel.clientPath and tunnel.profile`);

      const bridgeLogSink: BridgeHttpLogSink = (stream, message) => this.addLog("bridge", stream, message);
      bridge = await this.deps.listenBridge(config, bridgeLogSink);
      this.bridge = bridge;
      this.config = config;
      this.addLog("bridge", "stdout", `READY Bridge: ${bridge.url}`);

      const tunnelLogSink: TunnelLogSink = (stream, text) => this.addLog("tunnel", stream, text);
      const tunnel = this.options.captureTunnelOutput
        ? await this.deps.launchTunnel(config.tunnel, config.auth, { logSink: tunnelLogSink })
        : await this.deps.launchTunnel(config.tunnel, config.auth);
      this.tunnel = tunnel;
      this.addLog("tunnel", "stdout", `READY Tunnel profile: ${config.tunnel.profile}${tunnel.reused ? " (already running; reused)" : ""}`);
      this.addLog("controller", "stdout", `Loaded local environment: ${envPath}`);

      tunnel.child?.once("exit", (code, signal) => {
        if (this.state === "stopping" || this.state === "stopped") return;
        const reason = signal ?? `exit ${code ?? "unknown"}`;
        const message = `Tunnel client stopped unexpectedly (${reason})`;
        this.lastError = message;
        this.addLog("tunnel", "stderr", message);
        this.state = "error";
        this.options.onUnexpectedTunnelExit?.(message);
        const cleanup = this.cleanupAfterFailure();
        this.transition = cleanup;
        void cleanup.finally(() => {
          if (this.transition === cleanup) this.transition = undefined;
        });
      });

      this.startedAt = new Date().toISOString();
      this.healthProbeCache = undefined;
      this.state = "running";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.addLog("controller", "stderr", this.lastError);
      this.state = "error";
      if (this.tunnel) await this.tunnel.close().catch(() => undefined);
      if (bridge) await bridge.close().catch(() => undefined);
      this.tunnel = undefined;
      this.bridge = undefined;
      throw error;
    }
  }

  private async cleanupAfterFailure(): Promise<void> {
    const tunnel = this.tunnel;
    const bridge = this.bridge;
    this.tunnel = undefined;
    this.bridge = undefined;
    if (tunnel) await tunnel.close().catch(() => undefined);
    if (bridge) await bridge.close().catch(() => undefined);
  }

  public async stop(): Promise<void> {
    if (this.isStopped()) return;
    if (this.state === "stopping") {
      if (this.transition) await this.transition;
      return;
    }
    if (this.transition) {
      try {
        await this.transition;
      } catch {
        // Failed startup is already cleanable below.
      }
      if (this.isStopped()) return;
    }

    this.state = "stopping";
    const transition = this.doStop();
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
  }

  private async doStop(): Promise<void> {
    try {
      const tunnel = this.tunnel;
      const bridge = this.bridge;
      this.tunnel = undefined;
      this.bridge = undefined;
      if (tunnel) await tunnel.close();
      if (bridge) await bridge.close();
      this.addLog("controller", "stdout", "Bridge 和 Tunnel 已停止");
      this.state = "stopped";
      this.startedAt = undefined;
      this.lastError = undefined;
      this.healthProbeCache = undefined;
      this.localMcpProbeCache.clear();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.addLog("controller", "stderr", this.lastError);
      this.state = "error";
      throw error;
    }
  }

  private async getHealthProbe(config: BridgeConfig): Promise<{ readonly mcpReady: boolean; readonly tunnelReady: boolean }> {
    const now = Date.now();
    if (this.healthProbeCache && now - this.healthProbeCache.checkedAt < HEALTH_PROBE_TTL_MS) {
      return this.healthProbeCache;
    }
    if (this.healthProbeInFlight) return this.healthProbeInFlight;
    const probe = Promise.all([this.deps.probeMcp(config), this.deps.probeTunnel(config)])
      .then(([mcpReady, tunnelReady]) => {
        this.healthProbeCache = { checkedAt: Date.now(), mcpReady, tunnelReady };
        return { mcpReady, tunnelReady };
      })
      .finally(() => {
        if (this.healthProbeInFlight === probe) this.healthProbeInFlight = undefined;
      });
    this.healthProbeInFlight = probe;
    return probe;
  }

  public async getStatus(): Promise<BridgeControllerStatus> {
    const config = this.config;
    const state = this.state;
    if (!config) {
      return {
        state,
        bridge: state === "error" ? "error" : "stopped",
        mcp: "unavailable",
        tunnel: state === "error" ? "error" : "disconnected",
        pid: process.pid,
        ...(this.lastError ? { error: this.lastError } : {}),
      };
    }

    const shouldProbe = state === "running";
    const { mcpReady, tunnelReady } = shouldProbe
      ? await this.getHealthProbe(config)
      : { mcpReady: false, tunnelReady: false };

    return {
      state,
      bridge: state === "running" ? "running" : state === "error" ? "error" : "stopped",
      mcp: mcpReady ? "available" : "unavailable",
      tunnel: state === "error" ? "error" : tunnelReady ? "connected" : "disconnected",
      pid: process.pid,
      port: config.port,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
