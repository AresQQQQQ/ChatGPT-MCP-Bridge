import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ensureUiBootstrapConfig, readConnectionSetupStatus, runConnectionSetup, saveConnectionSettings } from "../src/ui/connection-setup.js";

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

async function setConfigPorts(configPath: string, bridgePort: number, healthPort: number): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.port = bridgePort;
  config.tunnelHealthPort = healthPort;
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
  assert.ok(status.missingItems.includes("Tunnel ID"));
  assert.ok(status.missingItems.includes("Tunnel profile 尚未初始化"));
});

test("connection setup saves shared settings first and creates a matching Tunnel MCP URL", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  let bridgePort = await freePort();
  let healthPort = await freePort();
  while (healthPort === bridgePort) healthPort = await freePort();
  await setConfigPorts(configPath, bridgePort, healthPort);
  let initializeArgs: string[] = [];
  const progress: string[] = [];
  await runConnectionSetup(configPath, {
    tunnelId: "tunnel_inline_test",
    runtimeKey: "runtime-key-fixture",
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
  assert.equal(config.tunnel?.tunnelId, "tunnel_inline_test");
  assert.equal(config.tunnelId, "tunnel_inline_test");
  assert.equal(config.tunnelHealthPort, healthPort);
  const urlIndex = initializeArgs.indexOf("--mcp-server-url");
  assert.ok(urlIndex >= 0);
  assert.equal(initializeArgs[urlIndex + 1], "http://127.0.0.1:" + bridgePort + "/mcp");
  assert.ok(progress.some(message => message.includes("保存统一连接配置")));
  const status = await readConnectionSetupStatus(configPath);
  assert.equal(status.ready, true);
  assert.equal(status.hasRuntimeKey, true);
  assert.equal(status.hasTunnelId, true);
  assert.equal(status.tunnelClientAvailable, true);
});

test("wizard keeps first-time API key and Tunnel ID after profile initialization fails", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  const bridgePort = await freePort();
  let healthPort = await freePort();
  while (healthPort === bridgePort) healthPort = await freePort();
  await setConfigPorts(configPath, bridgePort, healthPort);
  await assert.rejects(runConnectionSetup(configPath, {
    tunnelId: "tunnel_saved_after_failure",
    runtimeKey: "runtime-key-preserved-fixture",
  }, () => undefined, {
    install: async () => { throw new Error("simulated installer failure"); },
  }), /simulated installer failure/u);
  const config = await loadConfig(configPath);
  assert.equal(config.tunnelId, "tunnel_saved_after_failure");
  assert.equal(config.tunnel, undefined);
  const env = await readFile(path.join(root, ".env"), "utf8");
  assert.ok(env.includes("runtime-key-preserved-fixture"));
  const status = await readConnectionSetupStatus(configPath);
  assert.equal(status.hasTunnelId, true);
  assert.equal(status.hasRuntimeKey, true);
  assert.equal(status.ready, false);
});

test("API/port settings reject colliding ports before saving anything", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  const currentPort = await freePort();
  await setConfigPort(configPath, currentPort);
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-runtime-key\n");
  const beforeConfig = await readFile(configPath, "utf8");
  const beforeEnv = await readFile(path.join(root, ".env"), "utf8");
  await assert.rejects(saveConnectionSettings(configPath, {
    runtimeKey: "", bridgePort: 3200, healthPort: 3200,
  }), /不能与 Bridge 端口相同/u);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), beforeEnv);
});

test("API/port settings reject an occupied Bridge port before changing config", async t => {
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
  t.after(async () => { await new Promise<void>(resolve => occupied.close(() => resolve())); });
  const beforeConfig = await readFile(configPath, "utf8");
  const beforeEnv = await readFile(path.join(root, ".env"), "utf8");
  let healthPort = await freePort();
  while (healthPort === address.port) healthPort = await freePort();
  await assert.rejects(saveConnectionSettings(configPath, {
    runtimeKey: "", bridgePort: address.port, healthPort,
  }), /已被占用/u);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), beforeEnv);
});

test("API/port settings persist the Runtime API key and both ports before Tunnel setup", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  await setConfigPort(configPath, await freePort());
  const bridgePort = await freePort();
  let healthPort = await freePort();
  while (healthPort === bridgePort) healthPort = await freePort();
  const runtimeKey = "runtime-key-settings-fixture";
  await saveConnectionSettings(configPath, { runtimeKey, tunnelId: "tunnel_settings_fixture", bridgePort, healthPort });
  const config = await loadConfig(configPath);
  assert.equal(config.port, bridgePort);
  assert.equal(config.tunnelHealthPort, healthPort);
  assert.equal(config.tunnelId, "tunnel_settings_fixture");
  assert.equal(config.tunnel, undefined);
  const env = await readFile(path.join(root, ".env"), "utf8");
  assert.ok(env.includes('CONTROL_PLANE_API_KEY="' + runtimeKey + '"\n') || env.includes("CONTROL_PLANE_API_KEY=" + runtimeKey));
  assert.doesNotMatch(await readFile(configPath, "utf8"), new RegExp(runtimeKey));
  const status = await readConnectionSetupStatus(configPath);
  assert.equal(status.bridgePort, bridgePort);
  assert.equal(status.defaultHealthPort, healthPort);
  assert.equal(status.hasRuntimeKey, true);
  assert.equal(status.hasTunnelId, true);
  assert.equal(status.tunnelId, "tunnel_settings_fixture");
});

test("API/port settings refuse to change ports for a legacy Tunnel profile without a saved Tunnel ID", async t => {
  const root = await temporaryRoot(t);
  const configPath = path.join(root, "mcp-bridge.json");
  await ensureUiBootstrapConfig(configPath);
  const currentPort = await freePort();
  await setConfigPort(configPath, currentPort);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.tunnelHealthPort = 8080;
  config.tunnel = { clientPath: path.join(root, "fake-tunnel-client"), profile: "legacy", healthUrl: "http://127.0.0.1:8080" };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-key-fixture\n");
  const beforeConfig = await readFile(configPath, "utf8");
  const beforeEnv = await readFile(path.join(root, ".env"), "utf8");
  await assert.rejects(saveConnectionSettings(configPath, {
    runtimeKey: "", bridgePort: await freePort(), healthPort: 8080,
  }), /请先填写 Tunnel ID/u);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), beforeEnv);
});
