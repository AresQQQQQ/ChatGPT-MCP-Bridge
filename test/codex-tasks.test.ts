import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BridgeConfig } from "../src/config.js";
import { CodexBridgeError, resolveCodexLaunch, type CodexNotificationListener, type CodexRpcClient, type JsonObject } from "../src/codex/codex-client.js";
import type {
  CodexDesktopActivationController,
  CodexDesktopClient,
  CodexDesktopNotificationListener,
  CodexDesktopStartTurnInput,
  CodexDesktopTurnCompletion,
} from "../src/codex/codex-desktop.js";
import { CodexTaskManager } from "../src/codex/codex-tasks.js";
import { WorkspaceRegistry } from "../src/workspaces/workspace-registry.js";

interface Call {
  readonly method: string;
  readonly params: JsonObject;
}

interface DesktopCall {
  readonly method: string;
  readonly threadId: string;
  readonly ownerClientId?: string;
  readonly input?: CodexDesktopStartTurnInput;
  readonly following?: boolean;
  readonly turnId?: string;
}

class FakeCodexClient implements CodexRpcClient {
  public readonly calls: Call[] = [];
  public closeCount = 0;
  public maxConcurrentThreadListRequests = 0;
  private readonly listeners = new Set<CodexNotificationListener>();
  private threadCounter = 0;
  private turnCounter = 0;
  private readonly hiddenFromThreadLists = new Set<string>();
  private activeThreadListRequests = 0;
  private readonly threads = new Map<string, { cwd: string; name?: string; loaded: boolean; archived?: boolean; rolloutPath?: string }>();

  public constructor(
    private readonly root: string,
    private readonly options: {
      readonly lazyRollout?: boolean;
      readonly bootstrapCompletionDelayMs?: number;
      readonly threadListDelayMs?: number;
    } = {},
  ) {}

  public async request<T = unknown>(method: string, params: JsonObject = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "thread/start": {
        const id = `thr-${++this.threadCounter}`;
        const rolloutPath = this.options.lazyRollout ? path.join(this.root, `rollout-${id}.jsonl`) : undefined;
        this.threads.set(id, { cwd: String(params.cwd ?? this.root), loaded: true, ...(rolloutPath ? { rolloutPath } : {}) });
        return {
          thread: {
            id,
            cwd: String(params.cwd ?? this.root),
            status: { type: "idle" },
            ...(rolloutPath ? { path: rolloutPath, historyMode: "paginated" } : {}),
          },
        } as T;
      }
      case "thread/read": {
        const threadId = String(params.threadId ?? "");
        if (threadId === "foreign") return { thread: { id: threadId, cwd: path.join(this.root, "..", "other"), turns: [] } } as T;
        const thread = this.threads.get(threadId);
        if (!thread) throw new CodexBridgeError("thread not found");
        if (thread.archived) throw new CodexBridgeError(`session ${threadId} is archived. Run codex unarchive first.`);
        return { thread: { id: threadId, cwd: thread.cwd, name: thread.name, status: { type: thread.loaded ? "idle" : "notLoaded" }, turns: [] } } as T;
      }
      case "thread/unarchive": {
        const threadId = String(params.threadId ?? "");
        const thread = this.threads.get(threadId);
        if (!thread) throw new CodexBridgeError("thread not found");
        thread.archived = false;
        thread.loaded = false;
        return { thread: { id: threadId, cwd: thread.cwd, name: thread.name, status: { type: "notLoaded" }, turns: [] } } as T;
      }
      case "thread/resume": {
        const threadId = String(params.threadId ?? "");
        const thread = this.threads.get(threadId);
        if (!thread) throw new CodexBridgeError("thread not found");
        thread.loaded = true;
        return { thread: { id: threadId, cwd: thread.cwd, name: thread.name, status: { type: "idle" }, turns: [] } } as T;
      }
      case "thread/list": {
        this.activeThreadListRequests += 1;
        this.maxConcurrentThreadListRequests = Math.max(this.maxConcurrentThreadListRequests, this.activeThreadListRequests);
        try {
          if (this.options.threadListDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.options.threadListDelayMs));
          }
          const archived = params.archived === true;
          return {
            data: [...this.threads.entries()]
              .filter(([id, thread]) => !this.hiddenFromThreadLists.has(id) && Boolean(thread.archived) === archived)
              .map(([id, thread]) => ({ id, cwd: thread.cwd, name: thread.name })),
            nextCursor: null,
          } as T;
        } finally {
          this.activeThreadListRequests -= 1;
        }
      }
      case "thread/name/set": {
        const threadId = String(params.threadId ?? "");
        const thread = this.threads.get(threadId);
        if (thread) thread.name = String(params.name ?? "");
        return {} as T;
      }
      case "turn/start": {
        const turnId = `turn-${++this.turnCounter}`;
        const threadId = String(params.threadId ?? "");
        const thread = this.threads.get(threadId);
        if (thread?.rolloutPath) await writeFile(thread.rolloutPath, "materialized\n", "utf8");
        if (this.options.lazyRollout) {
          const delay = this.options.bootstrapCompletionDelayMs ?? 20;
          setTimeout(() => this.emit("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
            finalResponse: "bootstrap completed",
          }), delay).unref();
        }
        return { turn: { id: turnId, status: "inProgress" } } as T;
      }
      case "thread/items/list": {
        const turnId = String(params.turnId ?? "");
        return { data: [{ turnId, item: { type: "agentMessage", text: JSON.stringify({ summary: `done ${turnId}` }) } }] } as T;
      }
      case "turn/interrupt":
      case "thread/backgroundTerminals/clean":
        return {} as T;
      default:
        throw new CodexBridgeError(`unexpected method ${method}`);
    }
  }

  public async notify(_method: string, _params: JsonObject = {}): Promise<void> {}

  public onNotification(listener: CodexNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener(method, params);
  }

  public markNotLoaded(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.loaded = false;
  }

  public markArchived(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.archived = true;
      thread.loaded = false;
    }
  }

  public hideFromThreadLists(threadId: string): void {
    this.hiddenFromThreadLists.add(threadId);
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    for (const thread of this.threads.values()) thread.loaded = false;
  }
}

class FakeDesktopClient implements CodexDesktopClient {
  public readonly calls: DesktopCall[] = [];
  public closeCount = 0;
  public backgroundReconnectStarted = false;
  public interruptError: Error | undefined;
  private readonly listeners = new Set<CodexDesktopNotificationListener>();
  private readonly owners = new Map<string, string>();
  private readonly completions = new Map<string, CodexDesktopTurnCompletion>();
  private readonly conversationStates = new Map<string, JsonObject>();
  private turnCounter = 0;

  public async connect(): Promise<void> {}

  public startBackgroundReconnect(): void {
    this.backgroundReconnectStarted = true;
  }

  public getStatus() {
    return {
      available: true,
      ipcConnected: true,
      lastConnectedAt: "2026-08-25T00:00:00.000Z",
    };
  }

  public async discoverOwner(threadId: string): Promise<string | undefined> {
    this.calls.push({ method: "discoverOwner", threadId });
    return this.owners.get(threadId);
  }

  public async waitForOwner(threadId: string): Promise<string> {
    this.calls.push({ method: "waitForOwner", threadId });
    const owner = this.owners.get(threadId);
    if (!owner) throw new CodexBridgeError("no-client-found");
    return owner;
  }

  public async setFollowing(threadId: string, following: boolean): Promise<void> {
    this.calls.push({ method: "setFollowing", threadId, following });
  }

  public async syncConversationState(threadId: string, ownerClientId: string): Promise<void> {
    this.calls.push({ method: "syncConversationState", threadId, ownerClientId });
  }

  public getConversationState(threadId: string): JsonObject | undefined {
    const state = this.conversationStates.get(threadId);
    return state ? structuredClone(state) : undefined;
  }

  public async startTurn(input: CodexDesktopStartTurnInput, ownerClientId: string): Promise<{ readonly turnId: string }> {
    this.calls.push({ method: "startTurn", threadId: input.threadId, ownerClientId, input });
    return { turnId: `desktop-turn-${++this.turnCounter}` };
  }

  public async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    this.calls.push({ method: "interruptTurn", threadId, ...(turnId ? { turnId } : {}) });
    if (this.interruptError) throw this.interruptError;
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

  public activate(threadId: string): void {
    this.owners.set(threadId, "desktop-owner");
  }

  public clearOwner(threadId: string): void {
    this.owners.delete(threadId);
  }

  public setConversationState(threadId: string, state: JsonObject): void {
    this.conversationStates.set(threadId, structuredClone(state));
  }

  public emitDesktopNotification(method: string): void {
    for (const listener of this.listeners) listener(method, {});
  }

  public emitCompletion(threadId: string, turnId: string, status = "completed", finalResponse?: string): void {
    const completion: CodexDesktopTurnCompletion = {
      threadId,
      turnId,
      status,
      ...(finalResponse ? { finalResponse } : {}),
    };
    this.completions.set(`${threadId}\u0000${turnId}`, completion);
    for (const listener of this.listeners) {
      listener("turn/completed", {
        threadId,
        turn: { id: turnId, status },
        ...(finalResponse ? { finalResponse } : {}),
      });
    }
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class FakeActivationController implements CodexDesktopActivationController {
  public readonly opened: string[] = [];
  public restoreCount = 0;

  public constructor(private readonly desktop: FakeDesktopClient) {}

  public async captureForegroundWindow(): Promise<string> {
    return "12345";
  }

  public async openThread(threadId: string): Promise<void> {
    this.opened.push(threadId);
    this.desktop.activate(threadId);
  }

  public async restoreForegroundWindow(_handle: string): Promise<boolean> {
    this.restoreCount += 1;
    return true;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for Codex task state");
}

async function fixture(clientOptions: {
  readonly lazyRollout?: boolean;
  readonly bootstrapCompletionDelayMs?: number;
  readonly threadListDelayMs?: number;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-codex-"));
  await mkdir(path.join(root, "src"));
  const configPath = path.join(root, "bridge.json");
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 3000,
    mcpPath: "/mcp",
    maxReadBytes: 1024 * 1024,
    workspaces: [{
      id: "demo",
      root,
      mode: "workspace",
      codex: { enabled: true, modules: { media: "Media / PDF" } },
    }],
    configPath,
  };
  await writeFile(configPath, `${JSON.stringify({
    host: config.host,
    port: config.port,
    mcpPath: config.mcpPath,
    maxReadBytes: config.maxReadBytes,
    workspaces: config.workspaces,
  }, null, 2)}\n`, "utf8");
  const registry = await WorkspaceRegistry.create(config);
  const canonicalRoot = registry.listWorkspaces()[0]!.root;
  const client = new FakeCodexClient(canonicalRoot, clientOptions);
  const desktop = new FakeDesktopClient();
  const activation = new FakeActivationController(desktop);
  const stateFile = path.join(root, "codex-state.json");
  const manager = new CodexTaskManager({
    config,
    registry,
    client,
    desktopClient: desktop,
    activationController: activation,
    stateFile,
  });
  await manager.initialize();
  return { root, canonicalRoot, config, registry, stateFile, client, desktop, activation, manager };
}

test("Codex Desktop per-user runtime is preferred before PATH on Windows", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-codex-runtime-"));
  const pluginDir = path.join(root, ".codex", "plugins", ".plugin-appserver");
  const localAppData = path.join(root, "local");
  const cachedDir = path.join(localAppData, "OpenAI", "Codex", "bin", "hash-1");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(cachedDir, { recursive: true });
  const pluginRuntime = path.join(pluginDir, "codex.exe");
  await writeFile(pluginRuntime, "desktop runtime", "utf8");
  await writeFile(path.join(cachedDir, "codex.exe"), "cached runtime", "utf8");

  const previousUserProfile = process.env.USERPROFILE;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousPath = process.env.Path;
  const previousUpperPath = process.env.PATH;
  process.env.USERPROFILE = root;
  process.env.LOCALAPPDATA = localAppData;
  process.env.Path = "";
  process.env.PATH = "";
  try {
    const resolved = await resolveCodexLaunch();
    assert.equal(resolved.executable, pluginRuntime);
    assert.deepEqual(resolved.prefixArgs, []);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousPath === undefined) delete process.env.Path;
    else process.env.Path = previousPath;
    if (previousUpperPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousUpperPath;
  }
});

test("Codex tasks execute through Desktop IPC, let ChatGPT choose threads, queue one workspace writer, and dedupe request ids", async () => {
  const { canonicalRoot, client, desktop, activation, manager } = await fixture();
  try {
    assert.equal(desktop.backgroundReconnectStarted, true);
    const initialStatus = await manager.getStatus();
    assert.equal(initialStatus.desktop.ipcConnected, true);
    assert.equal(initialStatus.bridge.activeTasks, 0);
    assert.equal(initialStatus.bridge.queuedTasks, 0);
    const first = await manager.submitTask("demo", "media", "Fix PDF extraction", "req-1");
    const duplicate = await manager.submitTask("demo", "media", "this must not duplicate", "req-1");
    assert.equal(duplicate.taskId, first.taskId);

    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const runningFirst = await manager.getTask("demo", first.taskId);
    assert.equal(runningFirst.status, "running");
    assert.equal(runningFirst.model, "gpt-5.6-luna");
    assert.equal(runningFirst.effort, "max");
    assert.ok(runningFirst.threadId);
    assert.ok(runningFirst.turnId);

    const threadStart = client.calls.find((call) => call.method === "thread/start");
    assert.equal(threadStart?.params.cwd, canonicalRoot);
    assert.equal(threadStart?.params.approvalPolicy, "never");
    assert.equal(threadStart?.params.sandbox, "workspace-write");

    const firstTurn = desktop.calls.find((call) => call.method === "startTurn");
    assert.equal(firstTurn?.input?.text, "Fix PDF extraction");
    assert.doesNotMatch(firstTurn?.input?.text ?? "", /<codex_delegation>/u);
    assert.doesNotMatch(firstTurn?.input?.text ?? "", /Do not commit or push/u);
    assert.equal(firstTurn?.input?.clientUserMessageId, first.taskId);
    assert.equal(firstTurn?.input?.cwd, canonicalRoot);
    assert.equal(firstTurn?.input?.model, "gpt-5.6-luna");
    assert.equal(firstTurn?.input?.effort, "max");
    assert.equal(firstTurn?.input?.outputSchema, undefined);
    assert.equal(firstTurn?.ownerClientId, "desktop-owner");
    assert.deepEqual(activation.opened, [runningFirst.threadId]);
    assert.equal(activation.restoreCount, 1);

    const named = client.calls.find((call) => call.method === "thread/name/set");
    assert.equal(named?.params.threadId, runningFirst.threadId);
    assert.equal(named?.params.name, "[ChatGPT] Media / PDF");

    await assert.rejects(
      manager.submitTask("demo", "media", "Follow-up without explicit bound thread", "req-omit"),
      /already bound.*pass that threadId explicitly/iu,
    );
    const second = await manager.submitTask("demo", "media", "Follow-up while busy", "req-2", runningFirst.threadId, "gpt-5.5");
    assert.equal((await manager.getTask("demo", second.taskId)).status, "queued");
    assert.equal(desktop.calls.filter((call) => call.method === "startTurn").length, 1);

    desktop.emitCompletion(runningFirst.threadId!, "historical-turn", "completed", "old history");
    assert.equal((await manager.getTask("demo", first.taskId)).status, "running", "a terminal historical turn on the same thread must not finish the active task");

    desktop.emitCompletion(runningFirst.threadId!, runningFirst.turnId!, "completed", "done desktop-turn-1");
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 2);

    const completedFirst = await manager.getTask("demo", first.taskId);
    assert.equal(completedFirst.status, "completed");
    assert.match(completedFirst.finalResponse ?? "", /done desktop-turn-1/u);
    assert.ok(client.closeCount >= 1, "thread creation should release the short-lived app-server");
    assert.equal(client.calls.some((call) => call.method === "thread/resume"), false, "Desktop owns/resumes persisted threads");
    const runningSecond = await manager.getTask("demo", second.taskId);
    assert.equal(runningSecond.status, "running");
    assert.equal(runningSecond.threadId, runningFirst.threadId, "one module remains bound to one thread");
    assert.equal(runningSecond.model, "gpt-5.5");
    assert.equal(runningSecond.effort, "max", "explicit model override keeps the default max effort unless the user overrides effort too");
    const secondTurn = desktop.calls.filter((call) => call.method === "startTurn")[1];
    assert.equal(secondTurn?.input?.model, "gpt-5.5");
    assert.equal(secondTurn?.input?.effort, "max");

    desktop.emitCompletion(runningSecond.threadId!, runningSecond.turnId!, "completed", "done desktop-turn-2");
    await waitFor(() => manager.getTask("demo", second.taskId).then((task) => task.status === "completed"));
    const third = await manager.continueTask("demo", second.taskId, "Continue with the explicitly selected model", "req-3");
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 3);
    const runningThird = await manager.getTask("demo", third.taskId);
    assert.equal(runningThird.model, "gpt-5.5", "continueTask inherits the previous explicit model when the user does not override it again");
    assert.equal(runningThird.effort, "max");
    const thirdTurn = desktop.calls.filter((call) => call.method === "startTurn")[2];
    assert.equal(thirdTurn?.input?.model, "gpt-5.5");
    assert.equal(thirdTurn?.input?.effort, "max");
    assert.equal(client.calls.filter((call) => call.method === "thread/start").length, 1);
  } finally {
    await manager.close();
  }
});

test("Codex lazy-rollout new threads use an internal no-op bootstrap before the real Desktop turn", async () => {
  const { client, desktop, activation, manager } = await fixture({ lazyRollout: true, bootstrapCompletionDelayMs: 40 });
  try {
    const first = await manager.submitTask("demo", "media", "Real task after bootstrap", "lazy-bootstrap-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const runningFirst = await manager.getTask("demo", first.taskId);
    assert.equal(runningFirst.status, "running");
    assert.ok(runningFirst.threadId);
    assert.ok(runningFirst.turnId);
    assert.equal(client.calls.filter((call) => call.method === "thread/start").length, 1);
    const bootstrapTurn = client.calls.find((call) => call.method === "turn/start");
    assert.ok(bootstrapTurn, "new lazy-rollout threads require one internal app-server bootstrap turn");
    assert.notEqual(bootstrapTurn.params.input, undefined);
    assert.doesNotMatch(JSON.stringify(bootstrapTurn.params.input), /Real task after bootstrap/u, "the user's real task must not be executed by the bootstrap app-server");
    assert.match(JSON.stringify(bootstrapTurn.params.input), /BRIDGE_READY/u);
    assert.equal(client.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(desktop.calls.filter((call) => call.method === "startTurn").length, 1, "the real task must start through Desktop after bootstrap handoff");
    const realTurn = desktop.calls.find((call) => call.method === "startTurn");
    assert.equal(realTurn?.input?.text, "Real task after bootstrap");
    assert.deepEqual(activation.opened, [runningFirst.threadId]);

    desktop.emitCompletion(runningFirst.threadId!, runningFirst.turnId!, "completed", "real desktop result");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "completed"));
    const completed = await manager.getTask("demo", first.taskId);
    assert.equal(completed.finalResponse, "real desktop result");

    const second = await manager.submitTask("demo", "media", "Follow-up through Desktop", "lazy-bootstrap-2", completed.threadId);
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 2);
    const runningSecond = await manager.getTask("demo", second.taskId);
    assert.equal(runningSecond.status, "running");
    assert.equal(runningSecond.threadId, completed.threadId);
    assert.equal(client.calls.filter((call) => call.method === "turn/start").length, 1, "bootstrap is performed only once for the new thread");
  } finally {
    await manager.close();
  }
});

test("Codex explicitly selected threads are reactivated through Desktop instead of app-server resume", async () => {
  const { client, desktop, activation, manager } = await fixture();
  try {
    const first = await manager.submitTask("demo", "media", "First task", "resume-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const runningFirst = await manager.getTask("demo", first.taskId);
    assert.ok(runningFirst.threadId);
    assert.ok(runningFirst.turnId);
    desktop.emitCompletion(runningFirst.threadId!, runningFirst.turnId!, "completed", "done first");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "completed"));

    desktop.clearOwner(runningFirst.threadId!);
    client.markNotLoaded(runningFirst.threadId!);
    const second = await manager.submitTask("demo", "media", "Second task", "resume-2", runningFirst.threadId);
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 2);

    assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
    assert.equal(activation.opened.filter((threadId) => threadId === runningFirst.threadId).length, 2);
    assert.equal(activation.restoreCount, 2);
    const runningSecond = await manager.getTask("demo", second.taskId);
    assert.equal(runningSecond.threadId, runningFirst.threadId);
    assert.equal(runningSecond.status, "running");
  } finally {
    await manager.close();
  }
});

test("Codex rejects an explicitly selected archived thread instead of unarchiving it", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const first = await manager.submitTask("demo", "media", "First task", "archive-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const runningFirst = await manager.getTask("demo", first.taskId);
    assert.ok(runningFirst.threadId);
    assert.ok(runningFirst.turnId);
    desktop.emitCompletion(runningFirst.threadId!, runningFirst.turnId!, "completed", "done first");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "completed"));

    desktop.clearOwner(runningFirst.threadId!);
    client.markArchived(runningFirst.threadId!);
    await assert.rejects(
      manager.submitTask("demo", "media", "Second task", "archive-2", runningFirst.threadId),
      /archived/u,
    );

    assert.equal(client.calls.some((call) => call.method === "thread/unarchive"), false);
    assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
    assert.equal(desktop.calls.filter((call) => call.method === "startTurn").length, 1);
  } finally {
    await manager.close();
  }
});

test("Codex startup clears a persisted binding when its thread was archived while Bridge was offline", async () => {
  const { config, registry, stateFile, client, desktop, activation, manager } = await fixture();
  let restarted: CodexTaskManager | undefined;
  try {
    const first = await manager.submitTask("demo", "media", "Persist one module binding", "startup-binding-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", first.taskId);
    assert.ok(running.threadId);
    desktop.emitCompletion(running.threadId!, running.turnId!, "completed", "done");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "completed"));
    await manager.close();

    client.markArchived(running.threadId!);
    restarted = new CodexTaskManager({
      config,
      registry,
      client,
      desktopClient: desktop,
      activationController: activation,
      stateFile,
    });
    await restarted.initialize();
    const modules = await restarted.listModules("demo");
    const media = modules.find((module) => module.moduleId === "media");
    assert.equal(media?.bindingStatus, "unbound");
    assert.equal(media?.threadId, undefined);
  } finally {
    if (restarted) await restarted.close();
    else await manager.close();
  }
});

test("Codex archived module bindings are automatically cleared and can bind a replacement thread", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const first = await manager.submitTask("demo", "media", "First binding", "binding-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const runningFirst = await manager.getTask("demo", first.taskId);
    assert.ok(runningFirst.threadId);
    desktop.emitCompletion(runningFirst.threadId!, runningFirst.turnId!, "completed", "done first");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "completed"));

    let modules = await manager.listModules("demo");
    assert.equal(modules.find((module) => module.moduleId === "media")?.threadId, runningFirst.threadId);
    assert.equal(modules.find((module) => module.moduleId === "media")?.bindingStatus, "bound");

    desktop.clearOwner(runningFirst.threadId!);
    client.markArchived(runningFirst.threadId!);
    modules = await manager.listModules("demo");
    const mediaAfterArchive = modules.find((module) => module.moduleId === "media");
    assert.equal(mediaAfterArchive?.threadId, undefined);
    assert.equal(mediaAfterArchive?.bindingStatus, "unbound");

    const replacement = await manager.submitTask("demo", "media", "Replacement binding", "binding-2");
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 2);
    const runningReplacement = await manager.getTask("demo", replacement.taskId);
    assert.ok(runningReplacement.threadId);
    assert.notEqual(runningReplacement.threadId, runningFirst.threadId);
  } finally {
    await manager.close();
  }
});

test("Codex thread reads are bound to workspace cwd and list filters include appServer history", async () => {
  const { canonicalRoot, client, manager } = await fixture();
  try {
    const listedThreads = await manager.listThreads("demo", { limit: 5 });
    const list = client.calls.find((call) => call.method === "thread/list");
    assert.equal(list?.params.cwd, canonicalRoot);
    assert.deepEqual(list?.params.sourceKinds, ["cli", "vscode", "appServer"]);
    const listedData = listedThreads as { data?: Array<{ ownerPresent?: boolean }> };
    assert.equal(listedData.data?.every((thread) => typeof thread.ownerPresent === "boolean"), true);
    await assert.rejects(manager.readThread("demo", "foreign"), /does not belong to this workspace/u);
  } finally {
    await manager.close();
  }
});

test("Codex shared app-server metadata requests serialize their close lifecycle", async () => {
  const { client, manager } = await fixture({ threadListDelayMs: 25 });
  try {
    await Promise.all([
      manager.listThreads("demo", { limit: 5 }),
      manager.listThreads("demo", { limit: 5 }),
    ]);
    assert.equal(client.maxConcurrentThreadListRequests, 1, "one shared helper client must not serve overlapping request/close lifecycles");
    assert.ok(client.closeCount >= 2, "each serialized metadata operation should release the short-lived helper");
  } finally {
    await manager.close();
  }
});

test("Codex active thread reads use Desktop IPC only and never start the app-server helper", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "general", "Active read test");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.equal(running.status, "running");
    assert.ok(running.threadId);
    desktop.setConversationState(running.threadId!, {
      turns: [],
      threadRuntimeStatus: { type: "active" },
      turnHistory: {
        kind: "canonical",
        history: {
          entitiesByKey: {
            [`tail:0:local:${running.turnId}`]: {
              turnId: running.turnId,
              status: "inProgress",
              items: [{ type: "text", text: "Working through Desktop IPC" }],
            },
          },
        },
      },
    });

    const threadReadCallsBefore = client.calls.filter((call) => call.method === "thread/read").length;
    const result = await manager.readThread("demo", running.threadId!);
    const threadReadCallsAfter = client.calls.filter((call) => call.method === "thread/read").length;
    assert.equal(threadReadCallsAfter, threadReadCallsBefore, "active reads must not touch the app-server helper");
    assert.match(JSON.stringify(result), /Working through Desktop IPC/u);
    assert.ok(desktop.calls.some((call) => call.method === "syncConversationState" && call.threadId === running.threadId));
  } finally {
    await manager.close();
  }
});

test("Codex owned idle thread reads use Desktop IPC for conversation content", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "general", "Idle read setup");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    desktop.emitCompletion(running.threadId!, running.turnId!, "completed", "setup complete");
    await waitFor(() => manager.getTask("demo", task.taskId).then((current) => current.status === "completed"));

    desktop.activate(running.threadId!);
    desktop.setConversationState(running.threadId!, {
      turns: [],
      threadRuntimeStatus: { type: "idle" },
      turnHistory: {
        kind: "canonical",
        history: {
          entitiesByKey: {
            [`tail:0:local:${running.turnId}`]: {
              turnId: running.turnId,
              status: "completed",
              items: [{ type: "text", text: "Desktop-owned history" }],
            },
          },
        },
      },
    });
    const result = await manager.readThread("demo", running.threadId!);
    assert.match(JSON.stringify(result), /Desktop-owned history/u);
    assert.ok(client.calls.some((call) => call.method === "thread/read" && call.params.includeTurns === false));
    assert.equal(client.calls.some((call) => call.method === "thread/read" && call.params.includeTurns === true && call.params.threadId === running.threadId), false);
  } finally {
    await manager.close();
  }
});

test("Codex thread reads expose only user-visible messages", async () => {
  const { canonicalRoot, client, manager } = await fixture();
  const originalRequest = client.request.bind(client);
  client.request = async <T = unknown>(method: string, params: JsonObject = {}): Promise<T> => {
    if (method === "thread/read" && params.threadId === "public-thread") {
      return {
        thread: {
          id: "public-thread",
          name: "Visible history",
          cwd: canonicalRoot,
          createdAt: "2026-08-24T10:00:00Z",
          updatedAt: "2026-08-24T11:00:00Z",
          source: "vscode",
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [
              { type: "userMessage", text: "Please inspect this project" },
              { type: "reasoning", text: "private chain of thought" },
              { type: "commandExecution", command: "secret-command" },
              { type: "webSearch", query: "internal search" },
              { type: "agentMessage", text: "Inspection complete" },
            ],
          }],
        },
      } as T;
    }
    return originalRequest<T>(method, params);
  };
  try {
    const result = await manager.readThread("demo", "public-thread");
    const serialized = JSON.stringify(result);
    assert.match(serialized, /Please inspect this project/u);
    assert.match(serialized, /Inspection complete/u);
    assert.doesNotMatch(serialized, /private chain of thought/u);
    assert.doesNotMatch(serialized, /secret-command/u);
    assert.doesNotMatch(serialized, /internal search/u);
    assert.doesNotMatch(serialized, /reasoning|commandExecution|webSearch/u);
  } finally {
    await manager.close();
  }
});

test("Codex thread/module names normalize legacy ChatGPT prefixes to exactly one prefix", async () => {
  const { desktop, manager } = await fixture();
  try {
    const created = await manager.createConfiguredModule("demo", "legacy-prefix", "[ChatGPT] [ChatGPT] Legacy Name");
    assert.equal(created.displayName, "[ChatGPT] Legacy Name");
    const task = await manager.submitTask("demo", "legacy-prefix", "Create normalized thread");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.equal(running.status, "running");
    assert.equal((await manager.getModuleBindings("demo")).find((module) => module.moduleId === "legacy-prefix")?.displayName, "[ChatGPT] Legacy Name");
  } finally {
    await manager.close();
  }
});

test("Codex long-term module CRUD hot-updates config and preserves or clears bindings safely", async () => {
  const { root, desktop, manager } = await fixture();
  try {
    let created = await manager.createConfiguredModule("demo", "release", "Release / Packaging");
    assert.equal(created.moduleKind, "configured");
    assert.equal(created.bindingStatus, "unbound");
    assert.equal(created.displayName, "[ChatGPT] Release / Packaging");
    let configText = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "bridge.json"), "utf8"));
    assert.match(configText, /"release": "Release \/ Packaging"/u);
    assert.equal((await manager.getModuleBindings("demo")).some((module) => module.moduleId === "release" && module.moduleKind === "configured"), true);

    const task = await manager.submitTask("demo", "release", "Prepare release notes");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.ok(running.threadId);
    await assert.rejects(manager.deleteConfiguredModule("demo", "release"), /Cannot delete.*running/u);
    desktop.emitCompletion(running.threadId!, running.turnId!, "completed", "done");
    await waitFor(() => manager.getTask("demo", task.taskId).then((current) => current.status === "completed"));

    const updated = await manager.updateConfiguredModule("demo", "release", "Shipping");
    assert.equal(updated.displayName, "[ChatGPT] Shipping");
    assert.equal(updated.threadId, running.threadId);
    configText = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "bridge.json"), "utf8"));
    assert.match(configText, /"release": "Shipping"/u);

    const deleted = await manager.deleteConfiguredModule("demo", "release");
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.unboundThreadId, running.threadId);
    assert.equal((await manager.getModuleBindings("demo")).some((module) => module.moduleId === "release"), false);
    configText = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "bridge.json"), "utf8"));
    assert.doesNotMatch(configText, /"release"/u);
  } finally {
    await manager.close();
  }
});

test("Codex temporary module can be promoted to long-term without losing its binding", async () => {
  const { desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "investigation", "Investigate issue");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.ok(running.threadId);
    const promoted = await manager.createConfiguredModule("demo", "investigation", "Investigation");
    assert.equal(promoted.moduleKind, "configured");
    assert.equal(promoted.bindingStatus, "bound");
    assert.equal(promoted.threadId, running.threadId);
    const module = (await manager.getModuleBindings("demo")).find((candidate) => candidate.moduleId === "investigation");
    assert.equal(module?.moduleKind, "configured");
    assert.equal(module?.threadId, running.threadId);
  } finally {
    await manager.close();
  }
});

test("Codex dynamic modules are temporary and stay visible while their new thread is still busy", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "temp-race", "Temporary race test", "temp-race-1");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const queuedOrRunning = await manager.getTask("demo", task.taskId);
    assert.ok(queuedOrRunning.threadId);
    client.hideFromThreadLists(queuedOrRunning.threadId!);

    const modules = await manager.listModules("demo");
    const temporary = modules.find((module) => module.moduleId === "temp-race");
    assert.equal(temporary?.moduleKind, "temporary");
    assert.equal(temporary?.threadId, queuedOrRunning.threadId);
    assert.equal(temporary?.bindingStatus, "bound");
  } finally {
    await manager.close();
  }
});

test("Codex dynamic modules are temporary and disappear after manual unbind", async () => {
  const { desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "diagnose-owner-race", "Temporary investigation");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.ok(running.threadId);

    let modules = await manager.getModuleBindings("demo");
    const temporary = modules.find((module) => module.moduleId === "diagnose-owner-race");
    assert.equal(temporary?.moduleKind, "temporary");
    assert.equal(temporary?.bindingStatus, "bound");

    desktop.emitCompletion(running.threadId!, running.turnId!, "completed", "done");
    await waitFor(() => manager.getTask("demo", task.taskId).then((current) => current.status === "completed"));
    const result = await manager.unbindModule("demo", "diagnose-owner-race");
    assert.equal(result.moduleKind, "temporary");
    assert.equal(result.bindingStatus, "unbound");

    modules = await manager.getModuleBindings("demo");
    assert.equal(modules.some((module) => module.moduleId === "diagnose-owner-race"), false);
  } finally {
    await manager.close();
  }
});

test("Codex v4 migration discards all legacy v3 module bindings", async () => {
  const { config, registry, stateFile, client, desktop, activation, manager } = await fixture();
  await manager.close();
  await writeFile(stateFile, `${JSON.stringify({
    version: 3,
    modules: [
      { workspaceId: "demo", moduleId: "media", displayName: "[ChatGPT] Media / PDF", threadId: "legacy-media-thread" },
      { workspaceId: "demo", moduleId: "e2e-old", displayName: "[ChatGPT] e2e-old", threadId: "legacy-e2e-thread" },
    ],
    tasks: [],
  }, null, 2)}\n`, "utf8");

  const restarted = new CodexTaskManager({
    config,
    registry,
    client,
    desktopClient: desktop,
    activationController: activation,
    stateFile,
  });
  try {
    await restarted.initialize();
    const modules = await restarted.getModuleBindings("demo");
    const media = modules.find((module) => module.moduleId === "media");
    assert.equal(media?.moduleKind, "configured");
    assert.equal(media?.bindingStatus, "unbound");
    assert.equal(media?.threadId, undefined);
    assert.equal(modules.some((module) => module.moduleId === "e2e-old"), false);
  } finally {
    await restarted.close();
  }
});

test("Codex manual unbind clears only the Bridge binding and refuses while the module is busy", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "media", "Create bound thread");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.ok(running.threadId);
    await assert.rejects(manager.unbindModule("demo", "media"), /Cannot unbind.*running/u);

    desktop.emitCompletion(running.threadId!, running.turnId!, "completed", "done");
    await waitFor(() => manager.getTask("demo", task.taskId).then((current) => current.status === "completed"));
    const threadCallsBefore = client.calls.length;
    const unbound = await manager.unbindModule("demo", "media");
    assert.equal(unbound.bindingStatus, "unbound");
    assert.equal(unbound.threadId, undefined);
    assert.equal(client.calls.length, threadCallsBefore, "manual unbind must not archive, delete, resume, or otherwise touch Codex thread state");
    const modules = await manager.getModuleBindings("demo");
    assert.equal(modules.find((module) => module.moduleId === "media")?.bindingStatus, "unbound");
  } finally {
    await manager.close();
  }
});

test("Codex cancel interrupts the active Desktop turn without spawning an app-server writer", async () => {
  const { client, desktop, manager } = await fixture();
  try {
    const task = await manager.submitTask("demo", "general", "Run a task to cancel");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", task.taskId);
    assert.equal(running.status, "running");

    const cancelled = await manager.cancelTask("demo", task.taskId);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(desktop.calls.some((call) => call.method === "interruptTurn" && call.turnId === running.turnId));
    assert.equal(client.calls.some((call) => call.method === "turn/interrupt"), false);
    assert.equal(client.calls.some((call) => call.method === "thread/backgroundTerminals/clean"), false);
  } finally {
    await manager.close();
  }
});

test("Codex cancel keeps the workspace writer reserved when Desktop interrupt fails", async () => {
  const { desktop, manager } = await fixture();
  try {
    const first = await manager.submitTask("demo", "general", "First task");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", first.taskId);
    const second = await manager.submitTask("demo", "general", "Second task", undefined, running.threadId);
    assert.equal((await manager.getTask("demo", second.taskId)).status, "queued");

    desktop.interruptError = new Error("desktop interrupt unavailable");
    await assert.rejects(
      manager.cancelTask("demo", first.taskId),
      /task remains running.*writer stays reserved/iu,
    );
    assert.equal((await manager.getTask("demo", first.taskId)).status, "running");
    assert.equal((await manager.getTask("demo", second.taskId)).status, "queued");
    assert.equal(desktop.calls.filter((call) => call.method === "startTurn").length, 1);
  } finally {
    await manager.close();
  }
});

test("Codex Desktop reconnect resumes queued workspace tasks after an IPC disconnect", async () => {
  const { desktop, manager } = await fixture();
  try {
    const first = await manager.submitTask("demo", "general", "First task");
    await waitFor(() => desktop.calls.some((call) => call.method === "startTurn"));
    const running = await manager.getTask("demo", first.taskId);
    const second = await manager.submitTask("demo", "general", "Second task", undefined, running.threadId);
    assert.equal((await manager.getTask("demo", second.taskId)).status, "queued");

    desktop.emitDesktopNotification("bridge/codex-desktop/closed");
    await waitFor(() => manager.getTask("demo", first.taskId).then((task) => task.status === "failed"));
    assert.equal((await manager.getTask("demo", second.taskId)).status, "queued");
    assert.equal(desktop.calls.filter((call) => call.method === "startTurn").length, 1);

    desktop.activate(running.threadId!);
    desktop.emitDesktopNotification("bridge/codex-desktop/connected");
    await waitFor(() => desktop.calls.filter((call) => call.method === "startTurn").length === 2);
    assert.equal((await manager.getTask("demo", second.taskId)).status, "running");
  } finally {
    await manager.close();
  }
});
