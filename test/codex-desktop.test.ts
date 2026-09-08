import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import { test } from "node:test";

import { CodexDesktopIpcClient } from "../src/codex/codex-desktop.js";

interface Frame extends Record<string, unknown> {
  type?: string;
  method?: string;
  requestId?: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  params?: Record<string, unknown>;
}

function writeFrame(socket: Socket, frame: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

function createFrameReader(onFrame: (frame: Frame, socket: Socket) => void): (socket: Socket) => void {
  return (socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const frame = JSON.parse(buffer.toString("utf8", 4, 4 + length)) as Frame;
        buffer = buffer.subarray(4 + length);
        onFrame(frame, socket);
      }
    });
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for Codex Desktop IPC test event");
}

test("Codex Desktop IPC uses official v2 start-turn framing and observes real turnHistory completion patches", { skip: process.platform !== "win32" }, async () => {
  const pipePath = `\\\\.\\pipe\\mcp-bridge-codex-test-${process.pid}-${randomUUID()}`;
  const observed: Frame[] = [];
  let completionText: string | undefined;

  const server = net.createServer(createFrameReader((frame, socket) => {
    observed.push(frame);
    if (frame.type === "client-discovery-response") return;
    if (frame.type === "broadcast") return;
    if (frame.type !== "request" || !frame.requestId || !frame.method) return;

    if (frame.method === "initialize") {
      writeFrame(socket, {
        type: "response",
        requestId: frame.requestId,
        method: frame.method,
        resultType: "success",
        result: { clientId: "bridge-test-client" },
      });
      return;
    }

    if (frame.method === "thread-owner-discovery") {
      writeFrame(socket, {
        type: "response",
        requestId: frame.requestId,
        method: frame.method,
        resultType: "success",
        handledByClientId: "desktop-owner",
        result: {},
      });
      return;
    }

    if (frame.method === "thread-follower-start-turn") {
      writeFrame(socket, {
        type: "response",
        requestId: frame.requestId,
        method: frame.method,
        resultType: "success",
        handledByClientId: "desktop-owner",
        result: { result: { turn: { id: "turn-1" } } },
      });
      setTimeout(() => {
        writeFrame(socket, {
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          version: 11,
          params: {
            conversationId: "thread-1",
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: {
                turns: [],
                threadRuntimeStatus: { type: "active" },
                turnHistory: {
                  kind: "canonical",
                  history: {
                    generation: 1,
                    isComplete: true,
                    islands: [],
                    entitiesByKey: {
                      "tail:0:local:turn-1": {
                        turnId: "turn-1",
                        status: "inProgress",
                        items: [],
                      },
                    },
                  },
                },
              },
            },
          },
        });
        writeFrame(socket, {
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          version: 11,
          params: {
            conversationId: "thread-1",
            change: {
              type: "patches",
              baseRevision: 1,
              patches: [
                {
                  op: "add",
                  path: ["turnHistory", "history", "entitiesByKey", "tail:0:local:turn-1", "items", "#0"],
                  value: { type: "text", text: "desktop ipc complete" },
                },
                {
                  op: "replace",
                  path: ["turnHistory", "history", "entitiesByKey", "tail:0:local:turn-1", "status"],
                  value: "completed",
                },
                {
                  op: "replace",
                  path: ["threadRuntimeStatus"],
                  value: { type: "idle" },
                },
              ],
            },
          },
        });
      }, 20);
    }
  }));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });

  const client = new CodexDesktopIpcClient(pipePath);
  const unsubscribe = client.onNotification((method, params) => {
    if (method !== "turn/completed" || typeof params !== "object" || params === null) return;
    const finalResponse = (params as { finalResponse?: unknown }).finalResponse;
    if (typeof finalResponse === "string") completionText = finalResponse;
  });

  try {
    const owner = await client.discoverOwner("thread-1");
    assert.equal(owner, "desktop-owner");
    await client.setFollowing("thread-1", true);
    const started = await client.startTurn({
      threadId: "thread-1",
      cwd: "C:/work/project",
      clientUserMessageId: "task-1",
      text: "[ChatGPT]\nrun test",
      model: "gpt-5.6-luna",
      effort: "max",
      outputSchema: { type: "object" },
    }, owner!);
    assert.equal(started.turnId, "turn-1");

    const startFrame = await waitFor(() => observed.find((frame) => frame.method === "thread-follower-start-turn"));
    assert.equal(startFrame.version, 2);
    assert.equal(startFrame.targetClientId, "desktop-owner");
    const params = startFrame.params!;
    assert.equal(params.conversationId, "thread-1");
    const turnStart = params.turnStart as Record<string, unknown>;
    const request = turnStart.request as Record<string, unknown>;
    const context = turnStart.context as Record<string, unknown>;
    assert.equal(request.threadId, "thread-1");
    assert.equal(request.clientUserMessageId, "task-1");
    assert.equal(request.cwd, "C:/work/project");
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.effort, "max");
    const collaborationMode = request.collaborationMode as Record<string, unknown>;
    assert.equal(collaborationMode.mode, "default");
    const collaborationSettings = collaborationMode.settings as Record<string, unknown>;
    assert.equal(collaborationSettings.model, "gpt-5.6-luna");
    assert.equal(collaborationSettings.reasoning_effort, "max");
    assert.equal(collaborationSettings.developer_instructions, null);
    assert.equal(typeof request.outputSchema, "object");
    assert.deepEqual(context.localTurnMetadata, {});
    assert.deepEqual(context.attachments, []);
    assert.equal(context.inheritThreadSettings, true);

    const followingFrame = observed.find((frame) => frame.method === "thread-stream-following-changed");
    assert.equal(followingFrame?.type, "broadcast");
    assert.equal(followingFrame?.version, 1);
    assert.equal((followingFrame?.params as Record<string, unknown> | undefined)?.following, true);

    assert.equal(await waitFor(() => completionText), "desktop ipc complete");
    assert.equal(client.getFinalResponse("thread-1", "turn-1"), "desktop ipc complete");
    const state = client.getConversationState("thread-1")!;
    assert.deepEqual(state.turns, []);
    const turnHistory = state.turnHistory as Record<string, unknown>;
    const history = turnHistory.history as Record<string, unknown>;
    const entitiesByKey = history.entitiesByKey as Record<string, Record<string, unknown>>;
    const entity = entitiesByKey["tail:0:local:turn-1"]!;
    assert.equal(entity.status, "completed");
    assert.deepEqual(entity.items, [{ type: "text", text: "desktop ipc complete" }]);
  } finally {
    unsubscribe();
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
