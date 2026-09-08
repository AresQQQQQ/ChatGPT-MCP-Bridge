import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeController } from "../src/control/bridge-controller.js";
import type { BridgeConfig } from "../src/config.js";

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 3000,
  mcpPath: "/mcp",
  maxReadBytes: 1024,
  auth: { token: "A".repeat(43) },
  tunnel: {
    clientPath: "tunnel-client",
    profile: "test",
    healthUrl: "http://127.0.0.1:8080",
  },
  workspaces: [{
    id: "demo",
    root: ".",
    mcpServers: { local: { url: "http://127.0.0.1:3011/mcp" } },
  }],
  configPath: "/tmp/mcp-bridge.json",
};

function childEmitter(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  return child;
}

function createHarness(overrides: { delayedStart?: boolean } = {}) {
  let bridgeStarts = 0;
  let bridgeStops = 0;
  let tunnelStarts = 0;
  let tunnelStops = 0;
  let mcpProbes = 0;
  let tunnelProbes = 0;
  let localMcpLoaded = true;
  const child = childEmitter();
  let releaseBridge: (() => void) | undefined;
  const bridgeGate = overrides.delayedStart
    ? new Promise<void>((resolve) => { releaseBridge = resolve; })
    : Promise.resolve();

  const controller = new BridgeController(
    { configPath: config.configPath, maxLogLines: 3, maxLogChars: 1000 },
    {
      loadProjectEnv: async () => "/tmp/.env",
      loadConfig: async () => config,
      listenBridge: async () => {
        bridgeStarts += 1;
        await bridgeGate;
        return {
          url: "http://127.0.0.1:3000/mcp",
          listLocalMcpServers: () => [{
            workspaceId: "demo",
            serverId: "local",
            url: "http://127.0.0.1:3011/mcp",
            loaded: localMcpLoaded,
          }],
          loadLocalMcpServer: () => {
            localMcpLoaded = true;
            return { workspaceId: "demo", serverId: "local", url: "http://127.0.0.1:3011/mcp", loaded: true };
          },
          unloadLocalMcpServer: () => {
            localMcpLoaded = false;
            return { workspaceId: "demo", serverId: "local", url: "http://127.0.0.1:3011/mcp", loaded: false };
          },
          probeLocalMcpServer: async () => ({ toolCount: 10, latencyMs: 7 }),
          close: async () => { bridgeStops += 1; },
        };
      },
      launchTunnel: async () => {
        tunnelStarts += 1;
        return {
          child,
          reused: false,
          close: async () => { tunnelStops += 1; },
        };
      },
      probeMcp: async () => { mcpProbes += 1; return true; },
      probeTunnel: async () => { tunnelProbes += 1; return true; },
    },
  );

  return {
    controller,
    child,
    releaseBridge: () => releaseBridge?.(),
    counts: () => ({ bridgeStarts, bridgeStops, tunnelStarts, tunnelStops, mcpProbes, tunnelProbes }),
  };
}

test("controller transitions stopped -> starting -> running and protects duplicate start", async () => {
  const harness = createHarness({ delayedStart: true });
  const first = harness.controller.start();
  assert.equal(harness.controller.lifecycleState, "starting");
  const second = harness.controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.counts().bridgeStarts, 1);

  harness.releaseBridge();
  await Promise.all([first, second]);
  assert.equal(harness.controller.lifecycleState, "running");
  assert.equal(harness.counts().bridgeStarts, 1);
  assert.equal(harness.counts().tunnelStarts, 1);

  const status = await harness.controller.getStatus();
  assert.equal(status.bridge, "running");
  assert.equal(status.mcp, "available");
  assert.equal(status.tunnel, "connected");
});

test("controller stops tunnel and bridge and can return to stopped", async () => {
  const harness = createHarness();
  await harness.controller.start();
  await harness.controller.stop();
  assert.equal(harness.controller.lifecycleState, "stopped");
  assert.deepEqual(harness.counts(), { bridgeStarts: 1, bridgeStops: 1, tunnelStarts: 1, tunnelStops: 1, mcpProbes: 0, tunnelProbes: 0 });
});

test("unexpected tunnel exit moves controller to error, cleans bridge, and permits restart", async () => {
  const harness = createHarness();
  await harness.controller.start();
  harness.child.emit("exit", 7, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.controller.lifecycleState, "error");
  assert.equal(harness.counts().bridgeStops, 1);
  const status = await harness.controller.getStatus();
  assert.equal(status.bridge, "error");
  assert.equal(status.tunnel, "error");
  assert.match(status.error ?? "", /stopped unexpectedly/);

  await harness.controller.start();
  assert.equal(harness.controller.lifecycleState, "running");
  assert.equal(harness.counts().bridgeStarts, 2);
  assert.equal(harness.counts().tunnelStarts, 2);
});

test("controller UI local MCP controls share the live runtime registry", async () => {
  const harness = createHarness();
  const stoppedEntries = await harness.controller.getLocalMcpServers();
  assert.equal(stoppedEntries.length, 1);
  assert.equal(stoppedEntries[0]?.loaded, false);

  await harness.controller.start();
  assert.equal((await harness.controller.getLocalMcpServers())[0]?.loaded, true);

  harness.controller.unloadLocalMcpServer("demo", "local");
  assert.equal((await harness.controller.getLocalMcpServers())[0]?.loaded, false);

  const probed = await harness.controller.probeLocalMcpServer("demo", "local");
  assert.equal(probed.probeStatus, "available");
  assert.equal(probed.toolCount, 10);
  assert.equal(probed.latencyMs, 7);
  assert.equal(probed.loaded, false, "probing must not implicitly load the MCP");

  harness.controller.loadLocalMcpServer("demo", "local");
  assert.equal((await harness.controller.getLocalMcpServers())[0]?.loaded, true);
});

test("controller caches MCP and tunnel health probes between frequent UI status reads", async () => {
  const harness = createHarness();
  await harness.controller.start();
  await harness.controller.getStatus();
  await harness.controller.getStatus();
  await harness.controller.getStatus();
  assert.equal(harness.counts().mcpProbes, 1);
  assert.equal(harness.counts().tunnelProbes, 1);
});

test("log buffer keeps only the configured recent lines", () => {
  const harness = createHarness();
  harness.controller.addLog("bridge", "stdout", "one");
  harness.controller.addLog("bridge", "stdout", "two");
  harness.controller.addLog("tunnel", "stderr", "three");
  harness.controller.addLog("controller", "stdout", "four");
  assert.deepEqual(harness.controller.getLogs().map((entry) => entry.message), ["two", "three", "four"]);
});
