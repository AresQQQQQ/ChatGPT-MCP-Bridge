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

export interface LocalMcpRegistryEntry {
  readonly workspaceId: string;
  readonly serverId: string;
  readonly url: string;
  readonly loaded: boolean;
}

interface MutableLocalMcpRegistryEntry {
  workspaceId: string;
  serverId: string;
  url: string;
  loaded: boolean;
}

interface PersistedLocalMcpState {
  readonly version: 1;
  readonly servers: readonly {
    readonly workspaceId: string;
    readonly serverId: string;
    readonly loaded: boolean;
  }[];
}

const MAX_STATE_BYTES = 1024 * 1024;

function registryKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}\u0000${serverId}`;
}

export class LocalMcpRegistry {
  private readonly entries = new Map<string, MutableLocalMcpRegistryEntry>();
  private operationQueue: Promise<void> = Promise.resolve();
  private stateWarning: string | undefined;

  public constructor(
    config: BridgeConfig,
    private readonly stateFile?: string,
  ) {
    for (const workspace of config.workspaces) {
      for (const [serverId, server] of Object.entries(workspace.mcpServers ?? {})) {
        if (!isLoopbackUrl(server.url)) {
          throw new LocalMcpRegistryError(
            `Configured local MCP server '${workspace.id}/${serverId}' is not loopback-only`,
          );
        }
        this.entries.set(registryKey(workspace.id, serverId), {
          workspaceId: workspace.id,
          serverId,
          url: server.url,
          loaded: true,
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
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("state root is not an object");
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1 || !Array.isArray(record.servers)) throw new Error("unsupported state format");
      for (const item of record.servers) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const entry = item as Record<string, unknown>;
        if (typeof entry.workspaceId !== "string" || typeof entry.serverId !== "string" || typeof entry.loaded !== "boolean") continue;
        const configured = this.entries.get(registryKey(entry.workspaceId, entry.serverId));
        if (configured) configured.loaded = entry.loaded;
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

  public isLoaded(workspaceId: string, serverId: string): boolean {
    return this.requireEntry(workspaceId, serverId).loaded;
  }

  private setLoaded(workspaceId: string, serverId: string, loaded: boolean): Promise<LocalMcpRegistryEntry> {
    const operation = this.operationQueue.then(async () => {
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
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistState(): Promise<void> {
    if (!this.stateFile) return;
    const state: PersistedLocalMcpState = {
      version: 1,
      servers: this.list().map(({ workspaceId, serverId, loaded }) => ({ workspaceId, serverId, loaded })),
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
