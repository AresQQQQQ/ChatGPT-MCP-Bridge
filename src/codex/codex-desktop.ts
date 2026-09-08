import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import { promisify } from "node:util";

import { CodexBridgeError, type JsonObject } from "./codex-client.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PIPE = "\\\\.\\pipe\\codex-ipc";
const INITIALIZING_CLIENT = "initializing-client";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const START_TURN_TIMEOUT_MS = 120_000;
const HISTORY_SYNC_TIMEOUT_MS = 15_000;
const STATE_SYNC_WAIT_MS = 3_000;
const OWNER_WAIT_TIMEOUT_MS = 10_000;
const OWNER_POLL_MS = 120;
const BACKGROUND_RECONNECT_MS = 2_000;
const MAX_IPC_FRAME_BYTES = 16 * 1024 * 1024;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

const METHOD_VERSIONS: Readonly<Record<string, number>> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-load-complete-history": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-stream-following-changed": 1,
  "thread-stream-state-changed": 11,
};

export type CodexDesktopNotificationListener = (method: string, params: unknown) => void;
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexDesktopStartTurnInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly clientUserMessageId: string;
  readonly text: string;
  readonly model?: string;
  readonly effort?: CodexReasoningEffort;
  readonly outputSchema?: JsonObject;
}

export interface CodexDesktopTurnCompletion {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly finalResponse?: string;
}

export interface CodexDesktopStatus {
  readonly available: boolean;
  readonly ipcConnected: boolean;
  readonly lastConnectedAt?: string;
  readonly lastDisconnectedAt?: string;
  readonly lastError?: string;
}

export interface CodexDesktopClient {
  connect(): Promise<void>;
  startBackgroundReconnect(): void;
  getStatus(): CodexDesktopStatus;
  discoverOwner(threadId: string): Promise<string | undefined>;
  waitForOwner(threadId: string, timeoutMs?: number): Promise<string>;
  setFollowing(threadId: string, following: boolean): Promise<void>;
  syncConversationState(threadId: string, ownerClientId: string): Promise<void>;
  getConversationState(threadId: string): JsonObject | undefined;
  startTurn(input: CodexDesktopStartTurnInput, ownerClientId: string): Promise<{ readonly turnId: string }>;
  interruptTurn(threadId: string, turnId?: string): Promise<void>;
  getTurnCompletion(threadId: string, turnId: string): CodexDesktopTurnCompletion | undefined;
  getFinalResponse(threadId: string, turnId: string): string | undefined;
  onNotification(listener: CodexDesktopNotificationListener): () => void;
  close(): Promise<void>;
}

export interface CodexDesktopActivationController {
  captureForegroundWindow(): Promise<string | undefined>;
  openThread(threadId: string): Promise<void>;
  restoreForegroundWindow(handle: string): Promise<boolean>;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: IpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface IpcResponse {
  readonly result: unknown;
  readonly handledByClientId?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const candidate of paths) {
    let current: unknown = value;
    for (const key of candidate) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (typeof current === "string" && current.length > 0) return current;
  }
  return undefined;
}

function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/[\s_-]+/gu, "").toLowerCase();
}

function isTerminalStatus(value: unknown): boolean {
  const status = normalizeStatus(value);
  return status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled" || status === "canceled";
}

function publicMessageText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = nestedString(value, [["text"], ["content", "text"], ["message", "text"]]);
  if (direct) return direct;
  if (!Array.isArray(value.content)) return undefined;
  const parts: string[] = [];
  for (const part of value.content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part)) {
      const text = nestedString(part, [["text"], ["content", "text"]]);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function finalAgentResponse(turn: unknown): string | undefined {
  if (!isRecord(turn) || !Array.isArray(turn.items)) return undefined;
  let last: string | undefined;
  for (const raw of turn.items) {
    const item = isRecord(raw) && isRecord(raw.item) ? raw.item : raw;
    if (!isRecord(item) || (item.type !== "agentMessage" && item.type !== "text")) continue;
    const text = publicMessageText(item);
    if (text) last = text;
  }
  return last?.slice(0, 128 * 1024);
}

function turnHistoryEntities(state: unknown): readonly JsonObject[] {
  if (!isRecord(state) || !isRecord(state.turnHistory) || !isRecord(state.turnHistory.history)) return [];
  const entitiesByKey = state.turnHistory.history.entitiesByKey;
  if (!isRecord(entitiesByKey)) return [];
  return Object.values(entitiesByKey).filter((entity): entity is JsonObject => isRecord(entity));
}

function conversationTurnCandidates(state: JsonObject): readonly JsonObject[] {
  const history = turnHistoryEntities(state);
  if (history.length > 0) return history;
  return Array.isArray(state.turns) ? state.turns.filter((turn): turn is JsonObject => isRecord(turn)) : [];
}

function patchArrayIndex(segment: unknown): number | undefined {
  if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0) return segment;
  if (typeof segment !== "string") return undefined;
  const match = /^#(\d+)$/u.exec(segment);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new CodexBridgeError("Invalid Codex thread id");
}

export class CodexDesktopIpcClient implements CodexDesktopClient {
  private socket: Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private clientId: string | undefined;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<CodexDesktopNotificationListener>();
  private readonly conversationStates = new Map<string, JsonObject>();
  private readonly conversationRevisions = new Map<string, number>();
  private readonly stateWaiters = new Map<string, Set<() => void>>();
  private readonly completions = new Map<string, CodexDesktopTurnCompletion>();
  private readonly emittedTerminalTurns = new Set<string>();
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backgroundReconnectStarted = false;
  private lastConnectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;
  private lastError: string | undefined;

  public constructor(private readonly pipePath = DEFAULT_PIPE) {}

  public async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.clientId) return;
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectInternal();
    this.connectPromise = promise;
    try {
      await promise;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = undefined;
      for (const listener of this.listeners) listener("bridge/codex-desktop/connected", this.getStatus());
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = undefined;
    }
  }

  public startBackgroundReconnect(): void {
    if (this.backgroundReconnectStarted || this.closing) return;
    this.backgroundReconnectStarted = true;
    void this.backgroundConnectLoop();
  }

  public getStatus(): CodexDesktopStatus {
    const ipcConnected = Boolean(this.socket && !this.socket.destroyed && this.clientId);
    return {
      available: ipcConnected,
      ipcConnected,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastDisconnectedAt ? { lastDisconnectedAt: this.lastDisconnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  public async discoverOwner(threadId: string): Promise<string | undefined> {
    validateThreadId(threadId);
    try {
      const response = await this.sendRequest(
        "thread-owner-discovery",
        { hostId: "local", conversationId: threadId },
        { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
      );
      return response.handledByClientId;
    } catch (error) {
      if (error instanceof CodexBridgeError && /\bno-client-found\b/iu.test(error.message)) return undefined;
      throw error;
    }
  }

  public async waitForOwner(threadId: string, timeoutMs = OWNER_WAIT_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const owner = await this.discoverOwner(threadId);
        if (owner) return owner;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_MS));
    }
    if (lastError instanceof Error) throw lastError;
    throw new CodexBridgeError("Timed out waiting for Codex Desktop to own the thread");
  }

  public async setFollowing(threadId: string, following: boolean): Promise<void> {
    validateThreadId(threadId);
    await this.connect();
    this.writeFrame({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.requireClientId(),
      version: METHOD_VERSIONS["thread-stream-following-changed"] ?? 1,
      params: { hostId: "local", conversationId: threadId, following },
    });
    if (!following) {
      this.conversationStates.delete(threadId);
      this.conversationRevisions.delete(threadId);
    }
  }

  public async syncConversationState(threadId: string, ownerClientId: string): Promise<void> {
    validateThreadId(threadId);
    const previousRevision = this.conversationRevisions.get(threadId) ?? 0;
    await this.sendRequest(
      "thread-follower-load-complete-history",
      { conversationId: threadId },
      { targetClientId: ownerClientId, timeoutMs: HISTORY_SYNC_TIMEOUT_MS },
    );
    if ((this.conversationRevisions.get(threadId) ?? 0) > previousRevision) return;
    await this.waitForStateRevision(threadId, previousRevision, STATE_SYNC_WAIT_MS).catch(() => undefined);
  }

  public getConversationState(threadId: string): JsonObject | undefined {
    validateThreadId(threadId);
    const state = this.conversationStates.get(threadId);
    return state ? structuredClone(state) : undefined;
  }

  public async startTurn(input: CodexDesktopStartTurnInput, ownerClientId: string): Promise<{ readonly turnId: string }> {
    validateThreadId(input.threadId);
    if (!ownerClientId) throw new CodexBridgeError("Codex Desktop owner client id is required");
    const response = await this.sendRequest(
      "thread-follower-start-turn",
      {
        conversationId: input.threadId,
        turnStart: {
          request: {
            threadId: input.threadId,
            input: [{ type: "text", text: input.text, text_elements: [] }],
            cwd: input.cwd,
            clientUserMessageId: input.clientUserMessageId,
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...((input.model || input.effort) ? {
              collaborationMode: {
                mode: "default",
                settings: {
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.effort ? { reasoning_effort: input.effort } : {}),
                  developer_instructions: null,
                },
              },
            } : {}),
            ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          },
          context: {
            localTurnMetadata: {},
            attachments: [],
            commentAttachments: [],
            useAppServerPermissionDefault: false,
            usePermissionSelection: false,
            inheritThreadSettings: true,
            threadStartKind: "user",
          },
        },
      },
      { targetClientId: ownerClientId, timeoutMs: START_TURN_TIMEOUT_MS },
    );
    const turnId = nestedString(response.result, [
      ["result", "turn", "id"],
      ["result", "turnId"],
      ["turn", "id"],
      ["turnId"],
      ["id"],
    ]);
    if (!turnId) throw new CodexBridgeError("Codex Desktop start-turn did not return a turn id");
    return { turnId };
  }

  public async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    validateThreadId(threadId);
    const owner = await this.discoverOwner(threadId);
    if (!owner) throw new CodexBridgeError("Codex Desktop thread owner is unavailable");
    await this.sendRequest(
      "thread-follower-interrupt-turn",
      {
        conversationId: threadId,
        ...(turnId ? { expectedTurnId: turnId } : {}),
      },
      { targetClientId: owner, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    );
  }

  public getTurnCompletion(threadId: string, turnId: string): CodexDesktopTurnCompletion | undefined {
    return this.completions.get(`${threadId}\u0000${turnId}`);
  }

  public getFinalResponse(threadId: string, turnId: string): string | undefined {
    return this.getTurnCompletion(threadId, turnId)?.finalResponse;
  }

  public onNotification(listener: CodexDesktopNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async backgroundConnectLoop(): Promise<void> {
    if (this.closing) return;
    try {
      await this.connect();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.backgroundReconnectStarted || this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.backgroundConnectLoop();
    }, BACKGROUND_RECONNECT_MS);
    this.reconnectTimer.unref();
  }

  private async connectInternal(): Promise<void> {
    if (process.platform !== "win32") throw new CodexBridgeError("Codex Desktop IPC is only supported on Windows in this version");
    this.closing = false;
    this.buffer = Buffer.alloc(0);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new CodexBridgeError("Timed out connecting to Codex Desktop IPC"));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref();
      candidate.once("connect", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        clearTimeout(timer);
        reject(new CodexBridgeError(`Codex Desktop IPC is unavailable: ${error.message}`));
      });
    });
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.once("close", () => this.handleDisconnect());
    socket.once("error", (error) => {
      this.lastError = error.message;
      this.handleDisconnect();
    });

    const initialized = await this.sendRequestInternal(
      "initialize",
      { clientType: "chatgpt-mcp-bridge" },
      { requestId: `init-${randomUUID()}`, sourceClientId: INITIALIZING_CLIENT, version: 0, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    );
    const clientId = nestedString(initialized.result, [["clientId"]]);
    if (!clientId) {
      socket.destroy();
      throw new CodexBridgeError("Codex Desktop IPC initialize did not return a client id");
    }
    this.clientId = clientId;
  }

  private async sendRequest(
    method: string,
    params: JsonObject,
    options: { readonly targetClientId?: string; readonly timeoutMs?: number } = {},
  ): Promise<IpcResponse> {
    await this.connect();
    return this.sendRequestInternal(method, params, {
      sourceClientId: this.requireClientId(),
      version: METHOD_VERSIONS[method] ?? 0,
      ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  private sendRequestInternal(
    method: string,
    params: JsonObject,
    options: {
      readonly requestId?: string;
      readonly sourceClientId: string;
      readonly version: number;
      readonly targetClientId?: string;
      readonly timeoutMs?: number;
    },
  ): Promise<IpcResponse> {
    const requestId = options.requestId ?? randomUUID();
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexBridgeError(`Codex Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.writeFrame({
          type: "request",
          requestId,
          sourceClientId: options.sourceClientId,
          version: options.version,
          method,
          params,
          ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
          timeoutMs,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new CodexBridgeError("Codex Desktop IPC request could not be sent"));
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_IPC_FRAME_BYTES) {
        this.socket?.destroy(new Error("Invalid Codex Desktop IPC frame length"));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.toString("utf8", 4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let frame: unknown;
      try {
        frame = JSON.parse(payload) as unknown;
      } catch {
        continue;
      }
      if (isRecord(frame)) this.handleFrame(frame);
    }
  }

  private handleFrame(frame: JsonObject): void {
    if (frame.type === "client-discovery-request") {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : undefined;
      if (requestId) {
        this.writeFrame({ type: "client-discovery-response", requestId, response: { canHandle: false } });
      }
      return;
    }

    if (frame.type === "response") {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : undefined;
      if (!requestId) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (frame.resultType === "error") {
        const message = typeof frame.error === "string"
          ? frame.error
          : isRecord(frame.error) && typeof frame.error.message === "string"
            ? frame.error.message
            : `Codex Desktop IPC request failed: ${pending.method}`;
        pending.reject(new CodexBridgeError(message));
        return;
      }
      pending.resolve({
        result: frame.result,
        ...(typeof frame.handledByClientId === "string" ? { handledByClientId: frame.handledByClientId } : {}),
      });
      return;
    }

    if (frame.type === "broadcast" && frame.method === "thread-stream-state-changed") {
      this.handleThreadStateChanged(frame);
    }
  }

  private handleThreadStateChanged(frame: JsonObject): void {
    if (!isRecord(frame.params)) return;
    const threadId = typeof frame.params.conversationId === "string" ? frame.params.conversationId : undefined;
    if (!threadId || !isRecord(frame.params.change)) return;
    const current = this.conversationStates.get(threadId);
    const next = this.applyStateChange(current, frame.params.change);
    if (!next) return;
    this.conversationStates.set(threadId, next);
    const revision = typeof frame.params.change.revision === "number"
      ? frame.params.change.revision
      : typeof frame.params.change.baseRevision === "number"
        ? frame.params.change.baseRevision + 1
        : (this.conversationRevisions.get(threadId) ?? 0) + 1;
    this.conversationRevisions.set(threadId, revision);
    const waiters = this.stateWaiters.get(threadId);
    if (waiters) {
      this.stateWaiters.delete(threadId);
      for (const resolve of waiters) resolve();
    }
    for (const turn of conversationTurnCandidates(next)) {
      const turnId = nestedString(turn, [["turnId"], ["id"]]);
      const status = typeof turn.status === "string" ? turn.status : undefined;
      if (!turnId || !status || !isTerminalStatus(status)) continue;
      const key = `${threadId}\u0000${turnId}`;
      const responseText = finalAgentResponse(turn);
      const completion: CodexDesktopTurnCompletion = {
        threadId,
        turnId,
        status,
        ...(responseText ? { finalResponse: responseText } : {}),
      };
      this.completions.set(key, completion);
      if (this.emittedTerminalTurns.has(key)) continue;
      this.emittedTerminalTurns.add(key);
      for (const listener of this.listeners) {
        listener("turn/completed", {
          threadId,
          turn: { id: turnId, status },
          ...(completion.finalResponse ? { finalResponse: completion.finalResponse } : {}),
        });
      }
    }
  }

  private waitForStateRevision(threadId: string, previousRevision: number, timeoutMs: number): Promise<void> {
    if ((this.conversationRevisions.get(threadId) ?? 0) > previousRevision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.stateWaiters.get(threadId);
        waiters?.delete(onState);
        if (waiters && waiters.size === 0) this.stateWaiters.delete(threadId);
        reject(new CodexBridgeError("Timed out waiting for Codex Desktop conversation state"));
      }, timeoutMs);
      timer.unref();
      const onState = () => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = this.stateWaiters.get(threadId) ?? new Set<() => void>();
      waiters.add(onState);
      this.stateWaiters.set(threadId, waiters);
    });
  }

  private applyStateChange(current: JsonObject | undefined, change: JsonObject): JsonObject | undefined {
    if (change.type === "snapshot") {
      return isRecord(change.conversationState) ? structuredClone(change.conversationState) : undefined;
    }
    if (change.type !== "patches" || !current || !Array.isArray(change.patches)) return undefined;
    const next = structuredClone(current);
    for (const patch of change.patches) this.applyPatch(next, patch);
    return next;
  }

  private applyPatch(root: JsonObject, rawPatch: unknown): void {
    if (!isRecord(rawPatch) || typeof rawPatch.op !== "string" || !Array.isArray(rawPatch.path) || rawPatch.path.length === 0) return;
    let parent: unknown = root;
    for (let index = 0; index < rawPatch.path.length - 1; index += 1) {
      const segment: unknown = rawPatch.path[index];
      if (Array.isArray(parent)) {
        const arrayIndex = patchArrayIndex(segment);
        if (arrayIndex === undefined || arrayIndex >= parent.length) return;
        parent = parent[arrayIndex];
      } else if (isRecord(parent)) {
        const key = String(segment);
        if (!(key in parent)) parent[key] = patchArrayIndex(rawPatch.path[index + 1]) !== undefined ? [] : {};
        parent = parent[key];
      } else {
        return;
      }
    }
    const last = rawPatch.path[rawPatch.path.length - 1];
    if (Array.isArray(parent)) {
      const arrayIndex = patchArrayIndex(last);
      if (arrayIndex === undefined) return;
      if (rawPatch.op === "add") {
        if (arrayIndex > parent.length) return;
        parent.splice(arrayIndex, 0, structuredClone(rawPatch.value));
      } else if (rawPatch.op === "remove") {
        if (arrayIndex >= parent.length) return;
        parent.splice(arrayIndex, 1);
      } else if (rawPatch.op === "replace") {
        if (arrayIndex >= parent.length) return;
        parent[arrayIndex] = structuredClone(rawPatch.value);
      }
      return;
    }
    if (!isRecord(parent)) return;
    const key = String(last);
    if (rawPatch.op === "remove") delete parent[key];
    else if (rawPatch.op === "add" || rawPatch.op === "replace") parent[key] = structuredClone(rawPatch.value);
  }

  private writeFrame(frame: JsonObject): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new CodexBridgeError("Codex Desktop IPC is not writable");
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    if (body.length > MAX_IPC_FRAME_BYTES) throw new CodexBridgeError("Codex Desktop IPC frame is too large");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  }

  private requireClientId(): string {
    if (!this.clientId) throw new CodexBridgeError("Codex Desktop IPC is not initialized");
    return this.clientId;
  }

  private handleDisconnect(): void {
    const hadSocket = this.socket !== undefined;
    this.socket = undefined;
    this.clientId = undefined;
    if (hadSocket) this.lastDisconnectedAt = new Date().toISOString();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexBridgeError("Codex Desktop IPC disconnected"));
    }
    this.pending.clear();
    for (const waiters of this.stateWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.stateWaiters.clear();
    if (hadSocket && !this.closing) {
      this.lastError ??= "Codex Desktop IPC disconnected";
      for (const listener of this.listeners) listener("bridge/codex-desktop/closed", {});
      this.scheduleReconnect();
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.backgroundReconnectStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.clientId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexBridgeError("Codex Desktop IPC is shutting down"));
    }
    this.pending.clear();
    for (const waiters of this.stateWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.stateWaiters.clear();
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.destroy();
      });
    }
  }
}

const GET_FOREGROUND_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class McpBridgeForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@;
[Console]::Out.Write([McpBridgeForegroundWindow]::GetForegroundWindow().ToInt64())
`;

const RESTORE_FOREGROUND_SCRIPT = String.raw`
param([Int64]$Handle)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class McpBridgeForegroundWindow {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@;
$h = [IntPtr]::new($Handle)
if (-not [McpBridgeForegroundWindow]::IsWindow($h)) { [Console]::Out.Write('false'); exit 0 }
[Console]::Out.Write(([McpBridgeForegroundWindow]::SetForegroundWindow($h)).ToString().ToLowerInvariant())
`;

export class WindowsCodexDesktopActivationController implements CodexDesktopActivationController {
  public async captureForegroundWindow(): Promise<string | undefined> {
    if (process.platform !== "win32") return undefined;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", GET_FOREGROUND_SCRIPT],
        { windowsHide: true, timeout: 3_000, maxBuffer: 4_096, encoding: "utf8" },
      );
      const handle = stdout.trim();
      return /^\d+$/u.test(handle) && handle !== "0" ? handle : undefined;
    } catch {
      return undefined;
    }
  }

  public async openThread(threadId: string): Promise<void> {
    if (process.platform !== "win32") throw new CodexBridgeError("Codex Desktop deep-link activation is only supported on Windows");
    validateThreadId(threadId);
    const url = `codex://threads/${encodeURIComponent(threadId)}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("explorer.exe", [url], { shell: false, windowsHide: true, stdio: "ignore" });
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(new CodexBridgeError(`Could not activate Codex Desktop thread: ${error.message}`)));
    });
  }

  public async restoreForegroundWindow(handle: string): Promise<boolean> {
    if (process.platform !== "win32" || !/^\d+$/u.test(handle)) return false;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RESTORE_FOREGROUND_SCRIPT, handle],
        { windowsHide: true, timeout: 3_000, maxBuffer: 4_096, encoding: "utf8" },
      );
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }
}
