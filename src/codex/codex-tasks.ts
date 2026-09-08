import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BRIDGE_CAPABILITIES,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT,
} from "../capabilities.js";
import type { BridgeConfig, CodexWorkspaceConfig, WorkspaceConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import {
  CodexAppServerClient,
  CodexBridgeError,
  type CodexRpcClient,
  type JsonObject,
} from "./codex-client.js";
import {
  CodexDesktopIpcClient,
  WindowsCodexDesktopActivationController,
  type CodexDesktopActivationController,
  type CodexDesktopClient,
  type CodexReasoningEffort,
} from "./codex-desktop.js";

const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const REASONING_EFFORTS = new Set<CodexReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const MAX_INSTRUCTION_CHARS = 64 * 1024;
const MAX_MODULE_DISPLAY_NAME_CHARS = 128;
const MAX_THREAD_RESULT_CHARS = 512 * 1024;
const MAX_THREAD_BINDING_LIST_PAGES = 50;
const BOOTSTRAP_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
const NEW_THREAD_BOOTSTRAP_INSTRUCTION = "This is a Bridge connection bootstrap. Reply only BRIDGE_READY. Do not read, modify, create, delete, or execute any files, commands, tools, network requests, or external actions.";

export type CodexTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CodexModuleKind = "configured" | "temporary";

export interface CodexModuleRecord {
  readonly workspaceId: string;
  readonly moduleId: string;
  readonly displayName: string;
  readonly moduleKind: CodexModuleKind;
  readonly threadId?: string;
}

export interface CodexModuleView extends CodexModuleRecord {
  readonly bindingStatus: "bound" | "unbound";
  readonly threadName?: string;
  readonly archived?: boolean;
  readonly ownerPresent?: boolean;
}

export interface CodexModuleDeleteResult {
  readonly workspaceId: string;
  readonly moduleId: string;
  readonly deleted: true;
  readonly unboundThreadId?: string;
}

export interface CodexTaskRecord {
  readonly taskId: string;
  readonly requestId?: string;
  readonly workspaceId: string;
  readonly moduleId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly status: CodexTaskStatus;
  readonly instruction: string;
  readonly model?: string;
  readonly effort?: CodexReasoningEffort;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly finalResponse?: string;
}

interface PersistedCodexStateV4 {
  readonly version: 4;
  readonly modules: readonly CodexModuleRecord[];
  readonly tasks: readonly CodexTaskRecord[];
}

interface PersistedCodexStateV3 {
  readonly version: 3;
  readonly modules: readonly Omit<CodexModuleRecord, "moduleKind">[];
  readonly tasks: readonly CodexTaskRecord[];
}

interface PersistedCodexStateV2 {
  readonly version: 2;
  readonly modules: readonly {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly displayName: string;
    readonly lastThreadId?: string;
  }[];
  readonly tasks: readonly CodexTaskRecord[];
}

interface PersistedCodexStateV1 {
  readonly version: 1;
  readonly modules: readonly {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly displayName: string;
    readonly threadId?: string;
  }[];
  readonly tasks: readonly CodexTaskRecord[];
}

type PersistedCodexState = PersistedCodexStateV1 | PersistedCodexStateV2 | PersistedCodexStateV3 | PersistedCodexStateV4;

interface CodexThreadBindingState {
  readonly archived: boolean;
  readonly thread: JsonObject;
}

interface CodexThreadBindingInspection {
  readonly states: ReadonlyMap<string, CodexThreadBindingState>;
  readonly complete: boolean;
}

interface MutableTaskRecord {
  taskId: string;
  requestId?: string;
  workspaceId: string;
  moduleId: string;
  threadId?: string;
  turnId?: string;
  status: CodexTaskStatus;
  instruction: string;
  model?: string;
  effort?: CodexReasoningEffort;
  createdAt: string;
  updatedAt: string;
  error?: string;
  finalResponse?: string;
}

export interface CodexTaskManagerOptions {
  readonly config: BridgeConfig;
  readonly registry: WorkspaceRegistry;
  readonly client?: CodexRpcClient;
  readonly bootstrapClientFactory?: () => CodexRpcClient;
  readonly desktopClient?: CodexDesktopClient;
  readonly activationController?: CodexDesktopActivationController;
  readonly stateFile: string;
}

interface TaskThreadResolution {
  readonly threadId: string;
  readonly bootstrapClient?: CodexRpcClient;
  readonly rolloutPath?: string;
}

interface BootstrapTaskContext {
  readonly client: CodexRpcClient;
  turnId?: string;
  completed?: boolean;
  cancelWait?: (error: Error) => void;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const candidate of paths) {
    let current: unknown = value;
    for (const key of candidate) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    const result = stringValue(current);
    if (result) return result;
  }
  return undefined;
}

function boundedJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_THREAD_RESULT_CHARS) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_THREAD_RESULT_CHARS) };
}

function publicMessageText(item: JsonObject): string | undefined {
  const direct = getNestedString(item, [["text"], ["content", "text"], ["message", "text"]]);
  if (direct) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts: string[] = [];
  for (const part of item.content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = getNestedString(part, [["text"], ["content", "text"]]);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function publicThreadItem(raw: unknown): JsonObject | undefined {
  const item = isRecord(raw) && isRecord(raw.item) ? raw.item : raw;
  if (!isRecord(item) || typeof item.type !== "string") return undefined;
  if (item.type !== "userMessage" && item.type !== "agentMessage" && item.type !== "text") return undefined;
  const text = publicMessageText(item);
  if (!text) return undefined;
  return { type: item.type === "text" ? "agentMessage" : item.type, text };
}

function desktopConversationTurns(conversationState: JsonObject): readonly JsonObject[] {
  if (isRecord(conversationState.turnHistory) && isRecord(conversationState.turnHistory.history)) {
    const entitiesByKey = conversationState.turnHistory.history.entitiesByKey;
    if (isRecord(entitiesByKey)) {
      const entities = Object.values(entitiesByKey).filter((entity): entity is JsonObject => isRecord(entity));
      if (entities.length > 0) return entities;
    }
  }
  return Array.isArray(conversationState.turns)
    ? conversationState.turns.filter((turn): turn is JsonObject => isRecord(turn))
    : [];
}

function publicTurnsView(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.data)) return { data: [] };
  return {
    data: value.data.map((turn) => {
      if (!isRecord(turn)) return undefined;
      const publicTurn: JsonObject = {};
      for (const key of ["id", "status", "createdAt", "updatedAt"] as const) {
        if (turn[key] !== undefined) publicTurn[key] = turn[key];
      }
      if (Array.isArray(turn.items)) {
        publicTurn.items = turn.items.map(publicThreadItem).filter((item): item is JsonObject => item !== undefined);
      }
      return publicTurn;
    }).filter((turn): turn is JsonObject => turn !== undefined),
  };
}

function publicThreadView(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const thread = isRecord(value.thread) ? value.thread : undefined;
  if (!thread) return value;

  const publicThread: JsonObject = {};
  for (const key of ["id", "name", "cwd", "createdAt", "updatedAt", "source", "sourceKind", "archived"] as const) {
    if (thread[key] !== undefined) publicThread[key] = thread[key];
  }
  if (Array.isArray(thread.turns)) {
    publicThread.turns = thread.turns.map((turn) => {
      if (!isRecord(turn)) return undefined;
      const publicTurn: JsonObject = {};
      for (const key of ["id", "status", "createdAt", "updatedAt"] as const) {
        if (turn[key] !== undefined) publicTurn[key] = turn[key];
      }
      if (Array.isArray(turn.items)) {
        publicTurn.items = turn.items.map(publicThreadItem).filter((item): item is JsonObject => item !== undefined);
      }
      return publicTurn;
    }).filter((turn): turn is JsonObject => turn !== undefined);
  }
  return { thread: publicThread };
}

function publicDesktopThreadView(threadId: string, conversationState: JsonObject, metadata?: unknown): unknown {
  const metadataThread = isRecord(metadata) && isRecord(metadata.thread) ? metadata.thread : undefined;
  const publicThread: JsonObject = { id: threadId };
  if (metadataThread) {
    for (const key of ["name", "cwd", "createdAt", "updatedAt", "source", "sourceKind", "archived"] as const) {
      if (metadataThread[key] !== undefined) publicThread[key] = metadataThread[key];
    }
  }
  const turns = desktopConversationTurns(conversationState);
  if (turns.length > 0) {
    publicThread.turns = turns.map((turn) => {
      const publicTurn: JsonObject = {};
      for (const key of ["id", "turnId", "status", "createdAt", "updatedAt", "turnStartedAtMs", "durationMs"] as const) {
        if (turn[key] !== undefined) publicTurn[key === "turnId" ? "id" : key] = turn[key];
      }
      if (Array.isArray(turn.items)) {
        publicTurn.items = turn.items.map(publicThreadItem).filter((item): item is JsonObject => item !== undefined);
      }
      return publicTurn;
    });
  } else {
    publicThread.turns = [];
  }
  return { thread: publicThread };
}

function isTaskCancelled(task: MutableTaskRecord): boolean {
  return task.status === "cancelled";
}

function taskSnapshot(task: MutableTaskRecord): CodexTaskRecord {
  return {
    taskId: task.taskId,
    ...(task.requestId ? { requestId: task.requestId } : {}),
    workspaceId: task.workspaceId,
    moduleId: task.moduleId,
    ...(task.threadId ? { threadId: task.threadId } : {}),
    ...(task.turnId ? { turnId: task.turnId } : {}),
    status: task.status,
    instruction: task.instruction,
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.finalResponse ? { finalResponse: task.finalResponse } : {}),
  };
}

export class CodexTaskManager {
  private readonly client: CodexRpcClient;
  private readonly desktopClient: CodexDesktopClient;
  private readonly activationController: CodexDesktopActivationController;
  private readonly bootstrapClientFactory: () => CodexRpcClient;
  private readonly workspaces = new Map<string, WorkspaceConfig>();
  private readonly moduleRecords = new Map<string, CodexModuleRecord>();
  private readonly knownOwnerState = new Map<string, boolean>();
  private readonly tasks = new Map<string, MutableTaskRecord>();
  private readonly workspaceQueues = new Map<string, string[]>();
  private readonly activeWorkspaceTask = new Map<string, string>();
  private readonly bootstrapTasks = new Map<string, BootstrapTaskContext>();
  private persistTail: Promise<void> = Promise.resolve();
  private configWriteTail: Promise<void> = Promise.resolve();
  private appServerTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDesktop: () => void;

  public constructor(private readonly options: CodexTaskManagerOptions) {
    this.client = options.client ?? new CodexAppServerClient({
      ...(options.config.codex?.clientPath ? { clientPath: options.config.codex.clientPath } : {}),
    });
    this.bootstrapClientFactory = options.bootstrapClientFactory
      ?? (options.client
        ? () => this.client
        : () => new CodexAppServerClient({
          ...(options.config.codex?.clientPath ? { clientPath: options.config.codex.clientPath } : {}),
        }));
    this.desktopClient = options.desktopClient ?? new CodexDesktopIpcClient();
    this.activationController = options.activationController ?? new WindowsCodexDesktopActivationController();
    for (const workspace of options.config.workspaces) this.workspaces.set(workspace.id, workspace);
    this.unsubscribe = this.client.onNotification((method, params) => this.handleNotification(method, params));
    this.unsubscribeDesktop = this.desktopClient.onNotification((method, params) => this.handleNotification(method, params));
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    const promise = (async () => {
      await this.loadState();
      await this.reconcileModuleBindingsOnStartup();
      this.initialized = true;
      this.desktopClient.startBackgroundReconnect();
      await this.recoverInterruptedTasks();
    })();
    this.initializePromise = promise;
    try {
      await promise;
    } finally {
      if (this.initializePromise === promise) this.initializePromise = undefined;
    }
  }

  public async getStatus(): Promise<{
    readonly capabilities: typeof BRIDGE_CAPABILITIES;
    readonly desktop: ReturnType<CodexDesktopClient["getStatus"]>;
    readonly bridge: { readonly activeTasks: number; readonly queuedTasks: number };
    readonly knownThreads: readonly { readonly workspaceId: string; readonly moduleId: string; readonly threadId: string; readonly ownerPresent: boolean }[];
  }> {
    await this.initialize();
    let queuedTasks = 0;
    for (const queue of this.workspaceQueues.values()) queuedTasks += queue.length;
    const knownThreads = [...this.moduleRecords.values()]
      .filter((record): record is CodexModuleRecord & { readonly threadId: string } => typeof record.threadId === "string")
      .map((record) => ({
        workspaceId: record.workspaceId,
        moduleId: record.moduleId,
        threadId: record.threadId,
        ownerPresent: this.knownOwnerState.get(record.threadId) ?? false,
      }));
    return {
      capabilities: BRIDGE_CAPABILITIES,
      desktop: this.desktopClient.getStatus(),
      bridge: {
        activeTasks: this.activeWorkspaceTask.size,
        queuedTasks,
      },
      knownThreads,
    };
  }

  public async getModuleBindings(workspaceId: string): Promise<readonly CodexModuleView[]> {
    await this.initialize();
    const workspace = this.requireCodexWorkspace(workspaceId);
    const configured = workspace.codex.modules ?? {};
    const ids = new Set<string>(Object.keys(configured));
    for (const record of this.moduleRecords.values()) {
      if (record.workspaceId === workspaceId) ids.add(record.moduleId);
    }
    return [...ids]
      .map((moduleId): CodexModuleView => {
        const current = this.moduleRecords.get(this.moduleKey(workspaceId, moduleId));
        const moduleKind: CodexModuleKind = this.isConfiguredModule(workspaceId, moduleId) ? "configured" : "temporary";
        const base: CodexModuleRecord = {
          workspaceId,
          moduleId,
          displayName: this.moduleDisplayName(workspaceId, moduleId),
          moduleKind,
          ...(current?.threadId ? { threadId: current.threadId } : {}),
        };
        if (!base.threadId) return { ...base, bindingStatus: "unbound" };
        return {
          ...base,
          bindingStatus: "bound",
          archived: false,
          ownerPresent: this.knownOwnerState.get(base.threadId) ?? false,
        };
      })
      .sort((left, right) => {
        if (left.moduleKind !== right.moduleKind) return left.moduleKind === "configured" ? -1 : 1;
        return left.moduleId.localeCompare(right.moduleId);
      });
  }

  public async listModules(workspaceId: string): Promise<readonly CodexModuleView[]> {
    await this.initialize();
    const inspection = await this.reconcileWorkspaceModuleBindings(workspaceId).catch(() => undefined);
    const modules = await this.getModuleBindings(workspaceId);
    return Promise.all(modules.map(async (current): Promise<CodexModuleView> => {
      if (!current.threadId) return current;
      const state = inspection?.states.get(current.threadId);
      const ownerPresent = await this.desktopClient.discoverOwner(current.threadId)
        .then((owner) => Boolean(owner))
        .catch(() => false);
      this.knownOwnerState.set(current.threadId, ownerPresent);
      const threadName = state && typeof state.thread.name === "string" ? state.thread.name : undefined;
      return {
        ...current,
        ...(threadName ? { threadName } : {}),
        ...(state ? { archived: state.archived } : {}),
        ownerPresent,
      };
    }));
  }

  public async createConfiguredModule(workspaceId: string, moduleId: string, displayName: string): Promise<CodexModuleView> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertModuleId(moduleId);
    const normalizedName = this.normalizeModuleDisplayName(displayName);
    const modules = await this.mutateConfiguredModuleConfig(workspaceId, (current) => {
      if (Object.prototype.hasOwnProperty.call(current, moduleId)) {
        throw new CodexBridgeError(`Codex long-term module ${moduleId} already exists`);
      }
      current[moduleId] = normalizedName;
    });
    this.replaceWorkspaceModules(workspaceId, modules);

    const key = this.moduleKey(workspaceId, moduleId);
    const record = this.moduleRecords.get(key);
    if (record) {
      this.moduleRecords.set(key, {
        workspaceId,
        moduleId,
        displayName: this.moduleDisplayName(workspaceId, moduleId),
        moduleKind: "configured",
        ...(record.threadId ? { threadId: record.threadId } : {}),
      });
      await this.persist();
    }
    return this.requireConfiguredModuleView(workspaceId, moduleId);
  }

  public async updateConfiguredModule(workspaceId: string, moduleId: string, displayName: string): Promise<CodexModuleView> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertModuleId(moduleId);
    const normalizedName = this.normalizeModuleDisplayName(displayName);
    const modules = await this.mutateConfiguredModuleConfig(workspaceId, (current) => {
      if (!Object.prototype.hasOwnProperty.call(current, moduleId)) {
        throw new CodexBridgeError(`Unknown Codex long-term module ${moduleId}`);
      }
      current[moduleId] = normalizedName;
    });
    this.replaceWorkspaceModules(workspaceId, modules);

    const key = this.moduleKey(workspaceId, moduleId);
    const record = this.moduleRecords.get(key);
    if (record) {
      this.moduleRecords.set(key, {
        workspaceId,
        moduleId,
        displayName: this.moduleDisplayName(workspaceId, moduleId),
        moduleKind: "configured",
        ...(record.threadId ? { threadId: record.threadId } : {}),
      });
      await this.persist();
    }
    return this.requireConfiguredModuleView(workspaceId, moduleId);
  }

  public async deleteConfiguredModule(workspaceId: string, moduleId: string): Promise<CodexModuleDeleteResult> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertModuleId(moduleId);
    const busyTask = [...this.tasks.values()].find((task) =>
      task.workspaceId === workspaceId
      && task.moduleId === moduleId
      && (task.status === "queued" || task.status === "running"));
    if (busyTask) throw new CodexBridgeError(`Cannot delete Codex long-term module ${moduleId} while task ${busyTask.taskId} is ${busyTask.status}`);

    const key = this.moduleKey(workspaceId, moduleId);
    const record = this.moduleRecords.get(key);
    const modules = await this.mutateConfiguredModuleConfig(workspaceId, (current) => {
      if (!Object.prototype.hasOwnProperty.call(current, moduleId)) {
        throw new CodexBridgeError(`Unknown Codex long-term module ${moduleId}`);
      }
      delete current[moduleId];
    });
    this.replaceWorkspaceModules(workspaceId, modules);

    if (record?.threadId) this.knownOwnerState.delete(record.threadId);
    if (record) {
      this.moduleRecords.delete(key);
      await this.persist();
    }
    return {
      workspaceId,
      moduleId,
      deleted: true,
      ...(record?.threadId ? { unboundThreadId: record.threadId } : {}),
    };
  }

  public async unbindModule(workspaceId: string, moduleId: string): Promise<CodexModuleView> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertModuleId(moduleId);
    const busyTask = [...this.tasks.values()].find((task) =>
      task.workspaceId === workspaceId
      && task.moduleId === moduleId
      && (task.status === "queued" || task.status === "running"));
    if (busyTask) throw new CodexBridgeError(`Cannot unbind Codex module ${moduleId} while task ${busyTask.taskId} is ${busyTask.status}`);

    const key = this.moduleKey(workspaceId, moduleId);
    const current = this.moduleRecords.get(key);
    if (current?.threadId) this.knownOwnerState.delete(current.threadId);
    this.moduleRecords.delete(key);
    await this.persist();
    const moduleKind: CodexModuleKind = this.isConfiguredModule(workspaceId, moduleId) ? "configured" : "temporary";
    return {
      workspaceId,
      moduleId,
      displayName: this.moduleDisplayName(workspaceId, moduleId),
      moduleKind,
      bindingStatus: "unbound",
    };
  }

  public async listThreads(
    workspaceId: string,
    options: { readonly limit?: number; readonly cursor?: string; readonly archived?: boolean } = {},
  ): Promise<unknown> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    const canonical = this.canonicalRoot(workspaceId);
    const params: JsonObject = {
      limit: options.limit ?? 20,
      cwd: canonical,
      sourceKinds: ["cli", "vscode", "appServer"],
      sortKey: "recency_at",
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.archived !== undefined ? { archived: options.archived } : {}),
    };
    const result = await this.withAppServerClient((client) => client.request("thread/list", params));
    if (!isRecord(result) || !Array.isArray(result.data)) return boundedJson(result);
    const data = await Promise.all(result.data.map(async (thread) => {
      if (!isRecord(thread) || typeof thread.id !== "string") return thread;
      const ownerPresent = await this.desktopClient.discoverOwner(thread.id)
        .then((owner) => Boolean(owner))
        .catch(() => false);
      this.knownOwnerState.set(thread.id, ownerPresent);
      return { ...thread, ownerPresent };
    }));
    return boundedJson({ ...result, data });
  }

  public async readThread(workspaceId: string, threadId: string): Promise<unknown> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertThreadId(threadId);

    const activeTaskId = this.activeWorkspaceTask.get(workspaceId);
    const activeTask = activeTaskId ? this.tasks.get(activeTaskId) : undefined;
    const isActiveThread = Boolean(activeTask && activeTask.status === "running" && activeTask.threadId === threadId);

    let ownerClientId: string | undefined;
    try {
      ownerClientId = await this.desktopClient.discoverOwner(threadId);
    } catch (error) {
      if (isActiveThread) {
        throw new CodexBridgeError(`Cannot safely read an active Codex thread because Desktop owner discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }

    if (ownerClientId) {
      let metadata: unknown;
      if (!isActiveThread) {
        metadata = await this.withAppServerClient(async (client) => {
          const result = await client.request("thread/read", { threadId, includeTurns: false });
          this.assertThreadBelongsToWorkspace(workspaceId, result);
          return result;
        });
      }

      await this.desktopClient.setFollowing(threadId, true);
      try {
        await this.desktopClient.syncConversationState(threadId, ownerClientId);
        const conversationState = this.desktopClient.getConversationState(threadId);
        if (!conversationState) throw new CodexBridgeError("Codex Desktop did not provide conversation state for the selected thread");
        return boundedJson(publicDesktopThreadView(threadId, conversationState, metadata));
      } finally {
        if (!isActiveThread) await this.desktopClient.setFollowing(threadId, false).catch(() => undefined);
      }
    }

    if (isActiveThread) {
      throw new CodexBridgeError("Cannot safely read an active Codex thread after its Desktop owner became unavailable");
    }

    return this.withAppServerClient(async (client) => {
      try {
        const result = await client.request("thread/read", { threadId, includeTurns: true });
        this.assertThreadBelongsToWorkspace(workspaceId, result);
        return boundedJson(publicThreadView(result));
      } catch (error) {
        const metadata = await client.request("thread/read", { threadId, includeTurns: false });
        this.assertThreadBelongsToWorkspace(workspaceId, metadata);
        const turns = await client.request("thread/turns/list", {
          threadId,
          limit: 50,
          sortDirection: "desc",
          itemsView: "summary",
        }).catch(() => undefined);
        if (turns === undefined) throw error;
        return boundedJson({ metadata: publicThreadView(metadata), turns: publicTurnsView(turns) });
      }
    });
  }

  public async submitTask(
    workspaceId: string,
    moduleId: string,
    instruction: string,
    requestId?: string,
    threadId?: string,
    model: string = CODEX_DEFAULT_MODEL,
    effort: CodexReasoningEffort = CODEX_DEFAULT_REASONING_EFFORT,
  ): Promise<CodexTaskRecord> {
    await this.initialize();
    this.requireCodexWorkspace(workspaceId);
    this.assertModuleId(moduleId);
    this.assertInstruction(instruction);
    this.assertModel(model);
    this.assertReasoningEffort(effort);
    if (threadId !== undefined) this.assertThreadId(threadId);
    if (requestId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) throw new CodexBridgeError("Invalid Codex request id");
      const existing = [...this.tasks.values()].find((task) => task.workspaceId === workspaceId && task.requestId === requestId);
      if (existing) return taskSnapshot(existing);
    }

    const moduleInspection = await this.reconcileWorkspaceModuleBindings(workspaceId).catch(() => undefined);
    if (threadId) {
      let requestedState = moduleInspection?.states.get(threadId);
      if (!requestedState) {
        requestedState = (await this.inspectWorkspaceThreadBindings(workspaceId, new Set([threadId])).catch(() => undefined))?.states.get(threadId);
      }
      if (requestedState?.archived) {
        throw new CodexBridgeError("Selected Codex thread is archived; choose another thread or omit threadId to create a new conversation");
      }
    }
    const boundThreadId = this.moduleRecords.get(this.moduleKey(workspaceId, moduleId))?.threadId;
    if (boundThreadId && !threadId) {
      throw new CodexBridgeError(`Codex module ${moduleId} is already bound to thread ${boundThreadId}; pass that threadId explicitly to continue it`);
    }
    if (boundThreadId && threadId && threadId !== boundThreadId) {
      throw new CodexBridgeError(`Codex module ${moduleId} is already bound to a different thread; archive that thread before binding a replacement`);
    }

    const now = new Date().toISOString();
    const task: MutableTaskRecord = {
      taskId: `task_${randomUUID()}`,
      ...(requestId ? { requestId } : {}),
      workspaceId,
      moduleId,
      ...(threadId ? { threadId } : {}),
      status: "queued",
      instruction,
      model,
      effort,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    const queue = this.workspaceQueues.get(workspaceId) ?? [];
    queue.push(task.taskId);
    this.workspaceQueues.set(workspaceId, queue);
    await this.persist();
    void this.pumpWorkspace(workspaceId);
    return taskSnapshot(task);
  }

  public async getTask(workspaceId: string, taskId: string): Promise<CodexTaskRecord> {
    await this.initialize();
    const task = this.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) throw new CodexBridgeError("Unknown Codex task");
    return taskSnapshot(task);
  }

  public async continueTask(
    workspaceId: string,
    taskId: string,
    instruction: string,
    requestId?: string,
    model?: string,
    effort?: CodexReasoningEffort,
  ): Promise<CodexTaskRecord> {
    await this.initialize();
    const previous = this.tasks.get(taskId);
    if (!previous || previous.workspaceId !== workspaceId) throw new CodexBridgeError("Unknown Codex task");
    if (!previous.threadId) throw new CodexBridgeError("Previous Codex task does not have a thread to continue");
    return this.submitTask(
      workspaceId,
      previous.moduleId,
      instruction,
      requestId,
      previous.threadId,
      model ?? previous.model ?? CODEX_DEFAULT_MODEL,
      effort ?? previous.effort ?? CODEX_DEFAULT_REASONING_EFFORT,
    );
  }

  public async cancelTask(workspaceId: string, taskId: string): Promise<CodexTaskRecord> {
    await this.initialize();
    const task = this.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) throw new CodexBridgeError("Unknown Codex task");
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return taskSnapshot(task);

    if (task.status === "queued") {
      const queue = this.workspaceQueues.get(workspaceId) ?? [];
      this.workspaceQueues.set(workspaceId, queue.filter((candidate) => candidate !== taskId));
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return taskSnapshot(task);
    }

    const bootstrap = this.bootstrapTasks.get(taskId);
    if (bootstrap) {
      if (!task.threadId) {
        throw new CodexBridgeError("Cannot safely cancel a Codex bootstrap without its thread identifier");
      }
      if (bootstrap.turnId && !bootstrap.completed) {
        try {
          await bootstrap.client.request("turn/interrupt", { threadId: task.threadId, turnId: bootstrap.turnId });
        } catch (error) {
          throw new CodexBridgeError(`Codex creator app-server did not confirm the interrupt; task remains running and the workspace writer stays reserved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      bootstrap.cancelWait?.(new CodexBridgeError("Codex bootstrap turn was cancelled"));
    } else {
      if (!task.turnId || !task.threadId) {
        throw new CodexBridgeError("Cannot safely cancel an active Codex task without its thread and turn identifiers");
      }
      try {
        await this.desktopClient.interruptTurn(task.threadId, task.turnId);
      } catch (error) {
        throw new CodexBridgeError(`Codex Desktop did not confirm the interrupt; task remains running and the workspace writer stays reserved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Completion can race with the interrupt acknowledgement. If Desktop already
    // completed the exact turn, preserve that terminal result instead of
    // overwriting it with cancelled or releasing the writer twice.
    if (task.status !== "running" || this.activeWorkspaceTask.get(workspaceId) !== taskId) {
      return taskSnapshot(task);
    }

    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    this.activeWorkspaceTask.delete(workspaceId);
    await this.persist();
    await this.desktopClient.setFollowing(task.threadId, false).catch(() => undefined);
    if (bootstrap) {
      this.bootstrapTasks.delete(taskId);
      await bootstrap.client.close().catch(() => undefined);
    }
    void this.pumpWorkspace(workspaceId);
    return taskSnapshot(task);
  }

  private async pumpWorkspace(workspaceId: string): Promise<void> {
    if (this.activeWorkspaceTask.has(workspaceId)) return;
    const queue = this.workspaceQueues.get(workspaceId) ?? [];
    const taskId = queue.shift();
    this.workspaceQueues.set(workspaceId, queue);
    if (!taskId) return;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "queued") {
      void this.pumpWorkspace(workspaceId);
      return;
    }

    this.activeWorkspaceTask.set(workspaceId, taskId);
    try {
      const resolution = await this.resolveTaskThread(workspaceId, task.moduleId, task.threadId);
      task.threadId = resolution.threadId;
      if (resolution.bootstrapClient) {
        await this.runBootstrapTurn(workspaceId, task, resolution.threadId, resolution.bootstrapClient);
        return;
      }

      await this.startDesktopTaskTurn(workspaceId, task, resolution.threadId);
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      this.activeWorkspaceTask.delete(workspaceId);
      await this.persist();
      if (task.threadId) await this.desktopClient.setFollowing(task.threadId, false).catch(() => undefined);
      const bootstrap = this.bootstrapTasks.get(taskId);
      if (bootstrap) {
        this.bootstrapTasks.delete(taskId);
        await bootstrap.client.close().catch(() => undefined);
      }
      void this.pumpWorkspace(workspaceId);
    }
  }

  private async startDesktopTaskTurn(
    workspaceId: string,
    task: MutableTaskRecord,
    threadId: string,
    ownerClientId?: string,
  ): Promise<void> {
    const owner = ownerClientId ?? await this.ensureDesktopOwner(threadId);
    await this.desktopClient.setFollowing(threadId, true);
    await this.desktopClient.syncConversationState(threadId, owner).catch(() => undefined);
    if (isTaskCancelled(task)) return;

    const response = await this.desktopClient.startTurn({
      threadId,
      cwd: this.canonicalRoot(workspaceId),
      clientUserMessageId: task.taskId,
      text: task.instruction.trim(),
      model: task.model ?? CODEX_DEFAULT_MODEL,
      effort: task.effort ?? CODEX_DEFAULT_REASONING_EFFORT,
    }, owner);
    task.threadId = threadId;
    task.turnId = response.turnId;
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    this.bootstrapTasks.delete(task.taskId);
    await this.persist();
    await this.desktopClient.syncConversationState(threadId, owner).catch(() => undefined);
    const earlyCompletion = this.desktopClient.getTurnCompletion(threadId, response.turnId);
    if (earlyCompletion && task.status === "running" && this.activeWorkspaceTask.get(workspaceId) === task.taskId) {
      this.activeWorkspaceTask.delete(workspaceId);
      await this.finishTask(workspaceId, task, this.statusFromDesktopTurn(earlyCompletion.status), {
        threadId,
        turn: { id: response.turnId, status: earlyCompletion.status },
        ...(earlyCompletion.finalResponse ? { finalResponse: earlyCompletion.finalResponse } : {}),
      });
    }
  }

  private async resolveTaskThread(workspaceId: string, moduleId: string, requestedThreadId?: string): Promise<TaskThreadResolution> {
    await this.reconcileWorkspaceModuleBindings(workspaceId).catch(() => undefined);
    const boundThreadId = this.moduleRecords.get(this.moduleKey(workspaceId, moduleId))?.threadId;
    if (boundThreadId && requestedThreadId && requestedThreadId !== boundThreadId) {
      throw new CodexBridgeError(`Codex module ${moduleId} is already bound to a different thread; archive that thread before binding a replacement`);
    }
    if (boundThreadId && !requestedThreadId) {
      throw new CodexBridgeError(`Codex module ${moduleId} is already bound to thread ${boundThreadId}; pass that threadId explicitly to continue it`);
    }

    if (requestedThreadId) {
      try {
        const owner = await this.desktopClient.discoverOwner(requestedThreadId);
        if (owner) {
          await this.recordModuleThread(workspaceId, moduleId, requestedThreadId);
          return { threadId: requestedThreadId };
        }
      } catch (error) {
        throw new CodexBridgeError(`Codex Desktop IPC is required for task execution: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const metadata = await this.withAppServerClient((client) => client.request("thread/read", {
          threadId: requestedThreadId,
          includeTurns: false,
        }));
        this.assertThreadBelongsToWorkspace(workspaceId, metadata);
        await this.recordModuleThread(workspaceId, moduleId, requestedThreadId);
        return { threadId: requestedThreadId };
      } catch (error) {
        if (this.isThreadArchivedError(error)) {
          throw new CodexBridgeError("Selected Codex thread is archived; choose another thread or omit threadId to create a new conversation");
        }
        throw error;
      }
    }

    return this.createTaskThread(workspaceId, moduleId);
  }

  private async createTaskThread(workspaceId: string, moduleId: string): Promise<TaskThreadResolution> {
    this.requireCodexWorkspace(workspaceId);
    const canonical = this.canonicalRoot(workspaceId);
    const creator = this.bootstrapClientFactory();
    let keepCreator = false;
    try {
      const response = await creator.request("thread/start", {
        cwd: canonical,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const threadId = getNestedString(response, [["thread", "id"], ["id"], ["threadId"]]);
      if (!threadId) throw new CodexBridgeError("Codex thread/start did not return a thread id");
      const displayName = this.moduleDisplayName(workspaceId, moduleId);
      await creator.request("thread/name/set", { threadId, name: displayName }).catch(() => undefined);
      const rolloutPath = getNestedString(response, [["thread", "path"], ["path"]]);
      const rolloutExists = rolloutPath ? await stat(rolloutPath).then((metadata) => metadata.isFile()).catch(() => false) : true;
      if (!rolloutExists) {
        keepCreator = true;
        return { threadId, bootstrapClient: creator, ...(rolloutPath ? { rolloutPath } : {}) };
      }
      await this.recordModuleThread(workspaceId, moduleId, threadId);
      return { threadId, ...(rolloutPath ? { rolloutPath } : {}) };
    } finally {
      if (!keepCreator) await creator.close().catch(() => undefined);
    }
  }

  private async runBootstrapTurn(
    workspaceId: string,
    task: MutableTaskRecord,
    threadId: string,
    creator: CodexRpcClient,
  ): Promise<void> {
    let expectedTurnId: string | undefined;
    let unsubscribe = (): void => undefined;
    let timeout: NodeJS.Timeout | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const bootstrap: BootstrapTaskContext = { client: creator };
    const completion = new Promise<unknown>((resolve, reject) => {
      rejectCompletion = reject;
      timeout = setTimeout(() => reject(new CodexBridgeError("Timed out waiting for the Codex bootstrap turn to finish")), BOOTSTRAP_TURN_TIMEOUT_MS);
      timeout.unref();
      unsubscribe = creator.onNotification((method, params) => {
        if (method !== "turn/completed") return;
        const notificationThreadId = getNestedString(params, [["threadId"], ["thread", "id"]]);
        const notificationTurnId = getNestedString(params, [["turn", "id"], ["turnId"], ["id"]]);
        if (notificationThreadId && notificationThreadId !== threadId) return;
        if (expectedTurnId && notificationTurnId && notificationTurnId !== expectedTurnId) return;
        resolve(params);
      });
    });
    bootstrap.cancelWait = (error) => rejectCompletion?.(error);
    this.bootstrapTasks.set(task.taskId, bootstrap);

    try {
      const response = await creator.request("turn/start", {
        threadId,
        input: [{ type: "text", text: NEW_THREAD_BOOTSTRAP_INSTRUCTION, text_elements: [] }],
        cwd: this.canonicalRoot(workspaceId),
        model: CODEX_DEFAULT_MODEL,
        effort: "low",
      });
      expectedTurnId = getNestedString(response, [["turn", "id"], ["turnId"], ["id"]]);
      if (!expectedTurnId) throw new CodexBridgeError("Codex bootstrap turn/start did not return a turn id");
      bootstrap.turnId = expectedTurnId;
      task.threadId = threadId;
      task.status = "running";
      task.updatedAt = new Date().toISOString();
      await this.recordModuleThread(workspaceId, task.moduleId, threadId);
      await this.persist();

      let completionParams: unknown;
      try {
        completionParams = await completion;
      } catch (error) {
        if (isTaskCancelled(task)) return;
        throw error;
      }
      bootstrap.completed = true;
      if (isTaskCancelled(task)) return;

      const turnStatus = getNestedString(completionParams, [["turn", "status"], ["status"]]);
      const bootstrapStatus = this.statusFromDesktopTurn(turnStatus);
      if (bootstrapStatus !== "completed") {
        this.activeWorkspaceTask.delete(workspaceId);
        this.bootstrapTasks.delete(task.taskId);
        await this.finishTask(workspaceId, task, bootstrapStatus, {
          threadId,
          turn: { id: expectedTurnId, ...(turnStatus ? { status: turnStatus } : {}) },
        });
        return;
      }

      await creator.close().catch(() => undefined);
      const ownerClientId = await this.ensureDesktopOwner(threadId);
      if (isTaskCancelled(task)) return;
      await this.startDesktopTaskTurn(workspaceId, task, threadId, ownerClientId);
    } finally {
      unsubscribe();
      if (timeout) clearTimeout(timeout);
      if (this.bootstrapTasks.get(task.taskId)?.client === creator) this.bootstrapTasks.delete(task.taskId);
      await creator.close().catch(() => undefined);
    }
  }

  private async recordModuleThread(workspaceId: string, moduleId: string, threadId: string): Promise<void> {
    const key = this.moduleKey(workspaceId, moduleId);
    const current = this.moduleRecords.get(key);
    if (current?.threadId && current.threadId !== threadId) {
      throw new CodexBridgeError(`Codex module ${moduleId} is already bound to a different thread; archive that thread before binding a replacement`);
    }
    this.moduleRecords.set(key, {
      workspaceId,
      moduleId,
      displayName: this.moduleDisplayName(workspaceId, moduleId),
      moduleKind: this.isConfiguredModule(workspaceId, moduleId) ? "configured" : "temporary",
      threadId,
    });
    await this.persist();
  }

  private async ensureDesktopOwner(threadId: string, timeoutMs?: number): Promise<string> {
    const existing = await this.desktopClient.discoverOwner(threadId);
    if (existing) {
      this.knownOwnerState.set(threadId, true);
      return existing;
    }
    const previousForeground = await this.activationController.captureForegroundWindow();
    await this.activationController.openThread(threadId);
    try {
      const owner = await this.desktopClient.waitForOwner(threadId, timeoutMs);
      this.knownOwnerState.set(threadId, true);
      return owner;
    } finally {
      if (previousForeground) {
        await this.activationController.restoreForegroundWindow(previousForeground).catch(() => false);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "bridge/codex-desktop/connected") {
      void this.handleDesktopConnected();
      return;
    }
    if (method === "bridge/codex-desktop/closed") {
      for (const threadId of this.knownOwnerState.keys()) this.knownOwnerState.set(threadId, false);
      for (const taskId of this.activeWorkspaceTask.values()) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== "running") continue;
        task.status = "failed";
        task.error = "Codex Desktop IPC disconnected while the task was running";
        task.updatedAt = new Date().toISOString();
      }
      this.activeWorkspaceTask.clear();
      void this.persist();
      return;
    }
    if (method === "bridge/codex/closed") return;
    if (method !== "turn/completed") return;
    const threadId = getNestedString(params, [["threadId"], ["thread", "id"]]);
    const turnId = getNestedString(params, [["turn", "id"], ["turnId"], ["id"]]);
    if (!turnId) return;
    for (const [workspaceId, taskId] of this.activeWorkspaceTask) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "running" || !task.turnId) continue;
      if (task.turnId === turnId && (!threadId || task.threadId === threadId)) {
        const turnStatus = getNestedString(params, [["turn", "status"], ["status"]]);
        const nextStatus = this.statusFromDesktopTurn(turnStatus);
        this.activeWorkspaceTask.delete(workspaceId);
        void this.finishTask(workspaceId, task, nextStatus, params);
        break;
      }
    }
  }

  private async finishTask(
    workspaceId: string,
    task: MutableTaskRecord,
    status: CodexTaskStatus,
    completionParams: unknown,
  ): Promise<void> {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (status === "failed") {
      task.error = getNestedString(completionParams, [["turn", "error", "message"], ["error", "message"]]) ?? "Codex turn failed";
    } else if (status === "completed") {
      const finalResponse = getNestedString(completionParams, [["finalResponse"]])
        ?? await this.readFinalResponse(task).catch(() => undefined);
      if (finalResponse) task.finalResponse = finalResponse;
      else delete task.finalResponse;
    }
    await this.persist().catch(() => undefined);
    if (task.threadId) await this.desktopClient.setFollowing(task.threadId, false).catch(() => undefined);
    void this.pumpWorkspace(workspaceId);
  }

  private async inspectWorkspaceThreadBindings(
    workspaceId: string,
    threadIds: ReadonlySet<string>,
  ): Promise<CodexThreadBindingInspection> {
    if (threadIds.size === 0) return { states: new Map(), complete: true };
    const states = new Map<string, CodexThreadBindingState>();
    let complete = true;
    const canonical = this.canonicalRoot(workspaceId);
    return this.withAppServerClient(async (client) => {
      for (const archived of [false, true] as const) {
        let cursor: string | undefined;
        let pages = 0;
        do {
          const result = await client.request("thread/list", {
            limit: 100,
            cwd: canonical,
            sourceKinds: ["cli", "vscode", "appServer"],
            sortKey: "recency_at",
            archived,
            ...(cursor ? { cursor } : {}),
          });
          if (!isRecord(result) || !Array.isArray(result.data)) {
            throw new CodexBridgeError("Codex thread list did not return a usable result while checking module bindings");
          }
          for (const thread of result.data) {
            if (!isRecord(thread) || typeof thread.id !== "string" || !threadIds.has(thread.id)) continue;
            states.set(thread.id, { archived, thread });
          }
          cursor = stringValue(result.nextCursor);
          pages += 1;
          if (cursor && pages >= MAX_THREAD_BINDING_LIST_PAGES) {
            complete = false;
            break;
          }
          if ([...threadIds].every((threadId) => states.has(threadId))) break;
        } while (cursor);
      }
      return { states, complete };
    });
  }

  private async reconcileWorkspaceModuleBindings(workspaceId: string): Promise<CodexThreadBindingInspection> {
    this.requireCodexWorkspace(workspaceId);
    const records = [...this.moduleRecords.values()].filter(
      (record): record is CodexModuleRecord & { readonly threadId: string } => record.workspaceId === workspaceId && typeof record.threadId === "string",
    );
    if (records.length === 0) return { states: new Map(), complete: true };
    const threadIds = new Set(records.map((record) => record.threadId));
    const inspection = await this.inspectWorkspaceThreadBindings(workspaceId, threadIds);
    let changed = false;
    for (const record of records) {
      const state = inspection.states.get(record.threadId);
      const busyTask = [...this.tasks.values()].find((task) =>
        task.workspaceId === record.workspaceId
        && task.moduleId === record.moduleId
        && task.threadId === record.threadId
        && (task.status === "queued" || task.status === "running"));
      if (busyTask && !state?.archived) continue;
      if (!state?.archived && (state || !inspection.complete)) continue;
      if (record.moduleKind === "temporary") {
        this.moduleRecords.delete(this.moduleKey(record.workspaceId, record.moduleId));
      } else {
        this.moduleRecords.set(this.moduleKey(record.workspaceId, record.moduleId), {
          workspaceId: record.workspaceId,
          moduleId: record.moduleId,
          displayName: record.displayName,
          moduleKind: record.moduleKind,
        });
      }
      this.knownOwnerState.delete(record.threadId);
      changed = true;
    }
    if (changed) await this.persist();
    return inspection;
  }

  private async reconcileModuleBindingsOnStartup(): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      if (!workspace.codex?.enabled) continue;
      await this.reconcileWorkspaceModuleBindings(workspace.id).catch(() => undefined);
    }
  }

  private async handleDesktopConnected(): Promise<void> {
    await this.refreshKnownOwnerStates();
    for (const [workspaceId, queue] of this.workspaceQueues) {
      if (queue.length === 0 || this.activeWorkspaceTask.has(workspaceId)) continue;
      void this.pumpWorkspace(workspaceId);
    }
  }

  private async refreshKnownOwnerStates(): Promise<void> {
    const threadIds = new Set<string>();
    for (const record of this.moduleRecords.values()) {
      if (record.threadId) threadIds.add(record.threadId);
    }
    await Promise.all([...threadIds].map(async (threadId) => {
      const ownerPresent = await this.desktopClient.discoverOwner(threadId)
        .then((owner) => Boolean(owner))
        .catch(() => false);
      this.knownOwnerState.set(threadId, ownerPresent);
    }));
  }

  private statusFromDesktopTurn(status: string | undefined): CodexTaskStatus {
    const normalized = status?.replace(/[\s_-]+/gu, "").toLowerCase();
    if (normalized === "failed") return "failed";
    if (normalized === "interrupted" || normalized === "cancelled" || normalized === "canceled") return "cancelled";
    return "completed";
  }

  private withAppServerClient<T>(operation: (client: CodexRpcClient) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await operation(this.client);
      } finally {
        await this.client.close().catch(() => undefined);
      }
    };
    const result = this.appServerTail.then(run, run);
    this.appServerTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readFinalResponse(task: MutableTaskRecord): Promise<string | undefined> {
    if (!task.threadId || !task.turnId) return undefined;
    return this.desktopClient.getFinalResponse(task.threadId, task.turnId);
  }

  private async recoverInterruptedTasks(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "failed";
      task.error = "Bridge restarted while this Codex task was running; inspect the thread before retrying";
      task.updatedAt = new Date().toISOString();
    }
    for (const task of this.tasks.values()) {
      if (task.status !== "queued") continue;
      const queue = this.workspaceQueues.get(task.workspaceId) ?? [];
      if (!queue.includes(task.taskId)) queue.push(task.taskId);
      this.workspaceQueues.set(task.workspaceId, queue);
    }
    await this.persist();
    for (const workspaceId of this.workspaceQueues.keys()) void this.pumpWorkspace(workspaceId);
  }

  private assertThreadBelongsToWorkspace(workspaceId: string, result: unknown): void {
    this.requireCodexWorkspace(workspaceId);
    const cwd = getNestedString(result, [["thread", "cwd"], ["cwd"]]);
    if (!cwd) throw new CodexBridgeError("Codex thread scope could not be verified");
    const expected = path.normalize(this.canonicalRoot(workspaceId));
    const actual = path.normalize(cwd);
    const equal = process.platform === "win32" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
    if (!equal) throw new CodexBridgeError("Codex thread does not belong to this workspace");
  }

  private canonicalRoot(workspaceId: string): string {
    const workspace = this.options.registry.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) throw new CodexBridgeError("Unknown workspace");
    return workspace.root;
  }

  private requireCodexWorkspace(workspaceId: string): WorkspaceConfig & { readonly codex: CodexWorkspaceConfig } {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new CodexBridgeError("Unknown workspace");
    if (!workspace.codex?.enabled) throw new CodexBridgeError("Codex is not enabled for this workspace");
    const mode = workspace.mode ?? "workspace";
    if (mode !== "workspace" && mode !== "trusted-dev") throw new CodexBridgeError("Codex tasks require workspace or trusted-dev mode");
    return workspace as WorkspaceConfig & { readonly codex: CodexWorkspaceConfig };
  }

  private requireConfiguredModuleView(workspaceId: string, moduleId: string): CodexModuleView {
    const workspace = this.requireCodexWorkspace(workspaceId);
    if (!Object.prototype.hasOwnProperty.call(workspace.codex.modules ?? {}, moduleId)) {
      throw new CodexBridgeError(`Unknown Codex long-term module ${moduleId}`);
    }
    const record = this.moduleRecords.get(this.moduleKey(workspaceId, moduleId));
    return {
      workspaceId,
      moduleId,
      displayName: this.moduleDisplayName(workspaceId, moduleId),
      moduleKind: "configured",
      ...(record?.threadId ? { threadId: record.threadId, bindingStatus: "bound" as const } : { bindingStatus: "unbound" as const }),
      ...(record?.threadId ? { ownerPresent: this.knownOwnerState.get(record.threadId) ?? false } : {}),
    };
  }

  private normalizeModuleDisplayName(displayName: string): string {
    const normalized = displayName.trim();
    if (!normalized
      || normalized.length > MAX_MODULE_DISPLAY_NAME_CHARS
      || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
      throw new CodexBridgeError("Invalid Codex module display name");
    }
    return normalized;
  }

  private replaceWorkspaceModules(workspaceId: string, modules: Readonly<Record<string, string>>): void {
    const workspace = this.requireCodexWorkspace(workspaceId);
    const nextCodex: CodexWorkspaceConfig = Object.keys(modules).length > 0
      ? { ...workspace.codex, modules: { ...modules } }
      : { enabled: workspace.codex.enabled };
    this.workspaces.set(workspaceId, { ...workspace, codex: nextCodex });
  }

  private mutateConfiguredModuleConfig(
    workspaceId: string,
    mutate: (modules: Record<string, string>) => void,
  ): Promise<Readonly<Record<string, string>>> {
    const operation = this.configWriteTail.then(
      () => this.writeConfiguredModuleConfig(workspaceId, mutate),
      () => this.writeConfiguredModuleConfig(workspaceId, mutate),
    );
    this.configWriteTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeConfiguredModuleConfig(
    workspaceId: string,
    mutate: (modules: Record<string, string>) => void,
  ): Promise<Readonly<Record<string, string>>> {
    const configPath = this.options.config.configPath;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new CodexBridgeError(`Invalid JSON in Bridge config: ${configPath}`);
      throw error;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
      throw new CodexBridgeError(`Invalid Bridge config workspace list: ${configPath}`);
    }

    const workspaces = [...parsed.workspaces];
    const workspaceIndex = workspaces.findIndex((candidate) => isRecord(candidate) && candidate.id === workspaceId);
    if (workspaceIndex < 0) throw new CodexBridgeError(`Workspace ${workspaceId} is not present in the Bridge config file`);
    const rawWorkspace = workspaces[workspaceIndex];
    if (!isRecord(rawWorkspace)) throw new CodexBridgeError(`Invalid workspace ${workspaceId} in Bridge config`);
    if (!isRecord(rawWorkspace.codex) || rawWorkspace.codex.enabled === false) {
      throw new CodexBridgeError(`Codex is not enabled for workspace ${workspaceId} in the Bridge config file`);
    }

    const modules: Record<string, string> = {};
    const rawModules = rawWorkspace.codex.modules;
    if (rawModules !== undefined) {
      if (!isRecord(rawModules)) throw new CodexBridgeError(`Invalid Codex module config for workspace ${workspaceId}`);
      for (const [moduleId, displayName] of Object.entries(rawModules)) {
        if (!MODULE_ID_PATTERN.test(moduleId)
          || typeof displayName !== "string"
          || displayName.length < 1
          || displayName.length > MAX_MODULE_DISPLAY_NAME_CHARS
          || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(displayName)) {
          throw new CodexBridgeError(`Invalid Codex module config for workspace ${workspaceId}`);
        }
        modules[moduleId] = displayName;
      }
    }

    mutate(modules);
    const nextCodex: JsonObject = { ...rawWorkspace.codex };
    if (Object.keys(modules).length > 0) nextCodex.modules = { ...modules };
    else delete nextCodex.modules;
    workspaces[workspaceIndex] = { ...rawWorkspace, codex: nextCodex };
    const nextConfig: JsonObject = { ...parsed, workspaces };
    const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    const temporary = `${configPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const backup = `${configPath}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
    let backupCreated = false;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, configPath);
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (process.platform !== "win32" || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
        await rename(configPath, backup);
        backupCreated = true;
        try {
          await rename(temporary, configPath);
        } catch (replaceError) {
          await rename(backup, configPath).catch(() => undefined);
          backupCreated = false;
          throw replaceError;
        }
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
      if (backupCreated) await unlink(backup).catch(() => undefined);
    }
    return { ...modules };
  }

  private assertModuleId(moduleId: string): void {
    if (!MODULE_ID_PATTERN.test(moduleId)) throw new CodexBridgeError("Invalid Codex module id");
  }

  private assertThreadId(threadId: string): void {
    if (!THREAD_ID_PATTERN.test(threadId)) throw new CodexBridgeError("Invalid Codex thread id");
  }

  private assertModel(model: string): void {
    if (!MODEL_ID_PATTERN.test(model)) throw new CodexBridgeError("Invalid Codex model id");
  }

  private assertReasoningEffort(effort: CodexReasoningEffort): void {
    if (!REASONING_EFFORTS.has(effort)) throw new CodexBridgeError("Invalid Codex reasoning effort");
  }

  private assertInstruction(instruction: string): void {
    if (!instruction.trim() || instruction.length > MAX_INSTRUCTION_CHARS || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instruction)) {
      throw new CodexBridgeError("Invalid Codex task instruction");
    }
  }

  private isThreadArchivedError(error: unknown): boolean {
    return error instanceof CodexBridgeError && /\b(?:session|thread)\b.*\bis archived\b/iu.test(error.message);
  }

  private isConfiguredModule(workspaceId: string, moduleId: string): boolean {
    const workspace = this.requireCodexWorkspace(workspaceId);
    return Object.prototype.hasOwnProperty.call(workspace.codex.modules ?? {}, moduleId);
  }

  private moduleDisplayName(workspaceId: string, moduleId: string): string {
    const workspace = this.requireCodexWorkspace(workspaceId);
    const configuredName = workspace.codex.modules?.[moduleId] ?? (moduleId === "general" ? "General" : moduleId);
    const logicalName = configuredName.replace(/^(?:\[ChatGPT\]\s*)+/iu, "").trim() || (moduleId === "general" ? "General" : moduleId);
    return `[ChatGPT] ${logicalName}`;
  }

  private moduleKey(workspaceId: string, moduleId: string): string {
    return `${workspaceId}\u0000${moduleId}`;
  }

  private async loadState(): Promise<void> {
    let parsed: PersistedCodexState | undefined;
    try {
      parsed = JSON.parse(await readFile(this.options.stateFile, "utf8")) as PersistedCodexState;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    if (!parsed || !Array.isArray(parsed.modules) || !Array.isArray(parsed.tasks)) return;
    if (parsed.version === 4) {
      for (const module of parsed.modules) {
        if (!this.workspaces.has(module.workspaceId) || !MODULE_ID_PATTERN.test(module.moduleId) || !module.threadId) continue;
        const moduleKind: CodexModuleKind = this.isConfiguredModule(module.workspaceId, module.moduleId) ? "configured" : "temporary";
        this.moduleRecords.set(this.moduleKey(module.workspaceId, module.moduleId), {
          workspaceId: module.workspaceId,
          moduleId: module.moduleId,
          displayName: this.moduleDisplayName(module.workspaceId, module.moduleId),
          moduleKind,
          threadId: module.threadId,
        });
      }
    }
    for (const record of parsed.tasks) {
      if (!this.workspaces.has(record.workspaceId) || !MODULE_ID_PATTERN.test(record.moduleId)) continue;
      this.tasks.set(record.taskId, { ...record });
    }
  }

  private persist(): Promise<void> {
    const operation = this.persistTail.then(
      () => this.writePersistedState(),
      () => this.writePersistedState(),
    );
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  private async writePersistedState(): Promise<void> {
    const state: PersistedCodexStateV4 = {
      version: 4,
      modules: [...this.moduleRecords.values()],
      tasks: [...this.tasks.values()].slice(-500).map(taskSnapshot),
    };
    const directory = path.dirname(this.options.stateFile);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.options.stateFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, this.options.stateFile);
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (process.platform !== "win32" || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
        await unlink(this.options.stateFile).catch((unlinkError: unknown) => {
          const unlinkCode = unlinkError instanceof Error && "code" in unlinkError
            ? (unlinkError as NodeJS.ErrnoException).code
            : undefined;
          if (unlinkCode !== "ENOENT") throw unlinkError;
        });
        await rename(temporary, this.options.stateFile);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    this.unsubscribe();
    this.unsubscribeDesktop();
    await this.persist().catch(() => undefined);
    await Promise.all([this.client.close(), this.desktopClient.close()]);
  }
}
