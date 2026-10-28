import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ensureUiBootstrapConfig, readConnectionSetupStatus, runConnectionSetup } from "../src/ui/connection-setup.js";

async function temporaryRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-inline-connection-setup-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function setConfigPort(configPath: string, port: number): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.port = port;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("first-run bootstrap creates a minimal local config without overwriting an existing config", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  assert.equal(await ensureUiBootstrapConfig(configPath), true);
  const before = await readFile(configPath, "utf8");
  const config = await loadConfig(configPath);
  assert.equal(config.workspaces.length, 1);
  assert.ok(config.auth?.token);
  assert.equal(await ensureUiBootstrapConfig(configPath), false);
  assert.equal(await readFile(configPath, "utf8"), before);
  const status = await readConnectionSetupStatus(configPath);
  assert.equal(status.configExists, true);
  assert.equal(status.ready, false);
  assert.equal(status.hasRuntimeKey, false);
  assert.ok(status.missingItems.includes("Runtime API key"));
  assert.ok(status.missingItems.includes("Tunnel ID 与 profile"));
});

test("connection setup persists the selected Bridge port and creates a matching Tunnel MCP URL", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  await setConfigPort(configPath, await freePort());
  const bridgePort = await freePort();
  const healthPort = bridgePort === 8080 ? 8081 : 8080;
  let initializeArgs: string[] = [];
  const progress: string[] = [];
  await runConnectionSetup(configPath, {
    tunnelId: "tunnel_inline_test",
    runtimeKey: "runtime-key-fixture",
    healthPort,
    bridgePort,
    reuseClient: false,
  }, message => progress.push(message), {
    install: async directory => {
      const client = path.join(directory, "fake-tunnel-client");
      await writeFile(client, "test-client");
      return client;
    },
    initialize: async (_client, args) => {
      initializeArgs = args;
      const profileDir = args[args.indexOf("--profile-dir") + 1];
      await mkdir(profileDir, { recursive: true });
    },
  });
  const config = await loadConfig(configPath);
  assert.equal(config.port, bridgePort);
  assert.equal(config.tunnel?.healthUrl, "http://127.0.0.1:" + healthPort);
  const urlIndex = initializeArgs.indexOf("--mcp-server-url");
  assert.ok(urlIndex >= 0);
  assert.equal(initializeArgs[urlIndex + 1], "http://127.0.0.1:" + bridgePort + "/mcp");
  assert.ok(progress.length >= 0);
  const status = await readConnectionSetupStatus(configPath);
  assert.equal(status.ready, true);
  assert.equal(status.hasRuntimeKey, true);
  assert.equal(status.tunnelClientAvailable, true);
});

test("connection setup rejects colliding ports before invoking the installer", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  await setConfigPort(configPath, await freePort());
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-runtime-key\n");
  let installed = false;
  await assert.rejects(runConnectionSetup(configPath, {
    tunnelId: "tunnel_inline_test",
    runtimeKey: "",
    healthPort: 3200,
    bridgePort: 3200,
    reuseClient: false,
  }, () => undefined, {
    install: async () => { installed = true; throw new Error("should not install"); },
  }), /不能与 Bridge 端口相同/u);
  assert.equal(installed, false);
});

test("connection setup rejects an occupied Bridge port before invoking the installer", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  await setConfigPort(configPath, await freePort());
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-runtime-key\n");
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  let installed = false;
  t.after(async () => { await new Promise<void>(resolve => occupied.close(() => resolve())); });
  await assert.rejects(runConnectionSetup(configPath, {
    tunnelId: "tunnel_inline_test",
    runtimeKey: "",
    healthPort: address.port === 8080 ? 8081 : 8080,
    bridgePort: address.port,
    reuseClient: false,
  }, () => undefined, {
    install: async () => { installed = true; throw new Error("should not install"); },
  }), /已被占用/u);
  assert.equal(installed, false);
});
