import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, WorkspaceMcpServerConfig } from "../config.js";
import { isLoopbackUrl } from "../config.js";

export class LocalMcpRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalMcpRegistryError";
  }
}

export type LocalMcpRegistrySource = "config" | "runtime";

export interface LocalMcpRegistryEntry {
  readonly workspaceId: string;
  readonly serverId: string;
  readonly url: string;
  readonly loaded: boolean;
  readonly source: LocalMcpRegistrySource;
}

interface MutableLocalMcpRegistryEntry {
  workspaceId: string;
  serverId: string;
  url: string;
  loaded: boolean;
  source: LocalMcpRegistrySource;
}

interface PersistedLocalMcpStateV1 {
  readonly version: 1;
  readonly servers: readonly {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly loaded: boolean;
  }[];
}

interface PersistedLocalMcpStateV2 {
  readonly version: 2;
  readonly servers: readonly {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly url: string;
    readonly loaded: boolean;
  }[];
}

const MAX_STATE_BYTES = 1024 * 1024;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function registryKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}\u0000${serverId}`;
}

export class LocalMcpRegistry {
  private readonly entries = new Map<string, MutableLocalMcpRegistryEntry>();
  private readonly workspaceIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private stateWarning: string | undefined;

  public constructor(
    config: BridgeConfig,
    private readonly stateFile?: string,
  ) {
    for (const workspace of config.workspaces) {
      this.workspaceIds.add(workspace.id);
      for (const [serverId, server] of Object.entries(workspace.mcpServers ?? {})) {
        if (!isLoopbackUrl(server.url)) {
          throw new LocalMcpRegistryError(
            `Configured local MCP server '${workspace.id}/${serverId}' is not loopback-only`,
          );
        }
        const key = registryKey(workspace.id, serverId);
        this.entries.set(key, {
          workspaceId: workspace.id,
          serverId,
          url: server.url,
          loaded: true,
          source: "config",
        });
      }
    }
  }

  public async initialize(): Promise<void> {
    if (!this.stateFile) return;
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.stateWarning = `Could not read persisted local MCP state; configured defaults were used: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) {
      this.stateWarning = "Persisted local MCP state exceeded 1 MiB and was ignored; configured defaults were used";
      return;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedLocalMcpStateV1 | PersistedLocalMcpStateV2;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed.version !== 1 && parsed.version !== 2) ||
        !Array.isArray(parsed.servers)
      ) {
        throw new Error("unsupported state format");
      }

      let skipped = 0;
      for (const item of parsed.servers) {
        if (
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          typeof item.workspaceId !== "string" ||
          typeof item.serverId !== "string" ||
          typeof item.loaded !== "boolean"
        ) {
          skipped += 1;
          continue;
        }
        const key = registryKey(item.workspaceId, item.serverId);
        const configured = this.entries.get(key);
        if (configured) {
          configured.loaded = item.loaded;
          continue;
        }
        if (
          parsed.version !== 2 ||
          !this.workspaceIds.has(item.workspaceId) ||
          !SERVER_ID_PATTERN.test(item.serverId) ||
          typeof item.url !== "string" ||
          !isLoopbackUrl(item.url)
        ) {
          skipped += 1;
          continue;
        }
        this.entries.set(key, {
          workspaceId: item.workspaceId,
          serverId: item.serverId,
          url: item.url,
          loaded: item.loaded,
          source: "runtime",
        });
      }
      if (skipped > 0) {
        this.stateWarning = `Ignored ${skipped} stale or invalid persisted local MCP entr${skipped === 1 ? "y" : "ies"}`;
      }
    } catch (error) {
      this.stateWarning = `Persisted local MCP state was invalid and was ignored; configured defaults were used: ${error instanceof Error ? error.message : String(error)}`;
      for (const entry of this.entries.values()) entry.loaded = true;
    }
  }

  public consumeStateWarning(): string | undefined {
    const warning = this.stateWarning;
    this.stateWarning = undefined;
    return warning;
  }

  public list(workspaceId?: string): readonly LocalMcpRegistryEntry[] {
    return [...this.entries.values()]
      .filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId)
      .sort((left, right) => {
        const workspaceCompare = left.workspaceId.localeCompare(right.workspaceId);
        return workspaceCompare !== 0 ? workspaceCompare : left.serverId.localeCompare(right.serverId);
      })
      .map((entry) => ({ ...entry }));
  }

  public resolve(
    workspaceId: string,
    serverId: string,
    options: { readonly requireLoaded?: boolean } = {},
  ): WorkspaceMcpServerConfig {
    const entry = this.entries.get(registryKey(workspaceId, serverId));
    if (!entry) throw new LocalMcpRegistryError("Unknown local MCP server");
    if (options.requireLoaded !== false && !entry.loaded) {
      throw new LocalMcpRegistryError("Local MCP server is unloaded");
    }
    if (!isLoopbackUrl(entry.url)) {
      throw new LocalMcpRegistryError("Configured local MCP server is not loopback-only");
    }
    return { url: entry.url };
  }

  public load(workspaceId: string, serverId: string): Promise<LocalMcpRegistryEntry> {
    return this.setLoaded(workspaceId, serverId, true);
  }

  public unload(workspaceId: string, serverId: string): Promise<LocalMcpRegistryEntry> {
    return this.setLoaded(workspaceId, serverId, false);
  }

  public register(
    workspaceId: string,
    serverId: string,
    url: string,
    options: { readonly loaded?: boolean } = {},
  ): Promise<LocalMcpRegistryEntry> {
    return this.enqueue(async () => {
      if (!this.workspaceIds.has(workspaceId)) {
        throw new LocalMcpRegistryError(`Unknown workspace '${workspaceId}'`);
      }
      if (!SERVER_ID_PATTERN.test(serverId)) {
        throw new LocalMcpRegistryError(
          "serverId must use letters, numbers, dots, underscores, or hyphens",
        );
      }
      if (!isLoopbackUrl(url)) {
        throw new LocalMcpRegistryError("Local MCP URL must use a loopback http URL");
      }

      const key = registryKey(workspaceId, serverId);
      const existing = this.entries.get(key);
      if (existing?.source === "config" && existing.url !== url) {
        throw new LocalMcpRegistryError(
          `Local MCP '${workspaceId}/${serverId}' is config-managed; edit mcp-bridge.json to change its URL`,
        );
      }
      const entry: MutableLocalMcpRegistryEntry = {
        workspaceId,
        serverId,
        url,
        loaded: options.loaded ?? true,
        source: existing?.source === "config" ? "config" : "runtime",
      };
      this.entries.set(key, entry);
      try {
        await this.persistState();
      } catch (error) {
        if (existing) this.entries.set(key, existing);
        else this.entries.delete(key);
        throw new LocalMcpRegistryError(
          `Could not persist local MCP state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ...entry };
    });
  }

  public remove(workspaceId: string, serverId: string): Promise<LocalMcpRegistryEntry> {
    return this.enqueue(async () => {
      const key = registryKey(workspaceId, serverId);
      const existing = this.requireEntry(workspaceId, serverId);
      if (existing.source === "config") {
        throw new LocalMcpRegistryError(
          `Local MCP '${workspaceId}/${serverId}' is config-managed; edit mcp-bridge.json and restart Bridge to remove it`,
        );
      }
      this.entries.delete(key);
      try {
        await this.persistState();
      } catch (error) {
        this.entries.set(key, existing);
        throw new LocalMcpRegistryError(
          `Could not persist local MCP state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ...existing };
    });
  }

  public isLoaded(workspaceId: string, serverId: string): boolean {
    return this.requireEntry(workspaceId, serverId).loaded;
  }

  private setLoaded(workspaceId: string, serverId: string, loaded: boolean): Promise<LocalMcpRegistryEntry> {
    return this.enqueue(async () => {
      const entry = this.requireEntry(workspaceId, serverId);
      const previousLoaded = entry.loaded;
      entry.loaded = loaded;
      try {
        await this.persistState();
      } catch (error) {
        entry.loaded = previousLoaded;
        throw new LocalMcpRegistryError(
          `Could not persist local MCP state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ...entry };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persistState(): Promise<void> {
    if (!this.stateFile) return;
    const state: PersistedLocalMcpStateV2 = {
      version: 2,
      servers: this.list().map(({ workspaceId, serverId, url, loaded }) => ({
        workspaceId,
        serverId,
        url,
        loaded,
      })),
    };
    const directory = path.dirname(this.stateFile);
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.stateFile);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private requireEntry(workspaceId: string, serverId: string): MutableLocalMcpRegistryEntry {
    const entry = this.entries.get(registryKey(workspaceId, serverId));
    if (!entry) throw new LocalMcpRegistryError("Unknown local MCP server");
    return entry;
  }
}
