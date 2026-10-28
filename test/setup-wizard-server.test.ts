import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { configFileTemplate } from "../src/config.js";
import { launchSetupWizardServer } from "../src/ui/setup-wizard-server.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-setup-ui-"));
  const configPath = path.join(root, "mcp-bridge.json");
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=local-key-fixture\n");
  const ui = await launchSetupWizardServer(configPath);
  t.after(async () => { await ui.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { Authorization: "Bearer " + ui.token };
  async function request(route: string, body?: unknown) {
    return fetch(ui.origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...(body === undefined ? {} : { Origin: ui.origin, "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { root, configPath, ui, request };
}

test("setup wizard serves native UI assets, requires its local session token, and never returns keys or Tunnel IDs", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.ui.origin + "/api/snapshot")).status, 401);
  const snapshot = await (await f.request("/api/snapshot")).json() as Record<string, unknown>;
  assert.equal(snapshot.setupOnly, true);
  assert.equal(snapshot.configExists, false);
  assert.equal(snapshot.hasRuntimeKey, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /local-key-fixture|tunnel_fixture/);
  for (const route of ["/setup", "/setup.css", "/setup.js"]) {
    const response = await fetch(f.ui.origin + route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-security-policy"));
  }
});

test("setup wizard validates input, reports progress, and keeps submitted credentials out of snapshots", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-setup-ui-action-"));
  const configPath = path.join(root, "mcp-bridge.json");
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-key\n");
  let captured: Record<string, unknown> | undefined;
  const ui = await launchSetupWizardServer(configPath, {
    setup: async (input, deps) => {
      captured = input as unknown as Record<string, unknown>;
      deps?.progress?.("模拟：正在校验官方客户端");
    },
  });
  t.after(async () => { await ui.close(); await rm(root, { recursive: true, force: true }); });
  const post = (body: unknown, origin?: string) => fetch(ui.origin + "/api/setup", {
    method: "POST",
    headers: { Authorization: "Bearer " + ui.token, ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ tunnelId: "bad-id", runtimeKey: "", healthPort: 8081, reuseClient: false })).status, 400);
  assert.equal(captured, undefined);
  assert.equal((await post({ tunnelId: "tunnel_fixture", runtimeKey: "new-runtime-key-fixture", healthPort: 8081, reuseClient: false }, "http://evil.invalid")).status, 403);
  assert.equal(captured, undefined);
  // WPF PowerShell HTTP requests do not send an Origin header; the bearer token still authenticates them.
  const response = await post({ tunnelId: "tunnel_fixture", runtimeKey: "new-runtime-key-fixture", healthPort: 8081, reuseClient: false });
  assert.equal(response.status, 200);
  assert.equal(captured?.tunnelId, "tunnel_fixture");
  assert.equal(captured?.runtimeKey, "new-runtime-key-fixture");
  const snapshot = await (await fetch(ui.origin + "/api/snapshot", { headers: { Authorization: "Bearer " + ui.token } })).text();
  assert.match(snapshot, /"success":true/u);
  assert.doesNotMatch(snapshot, /new-runtime-key-fixture|tunnel_fixture/);
});

test("setup wizard requires a Runtime API key for a fresh local configuration", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-setup-ui-key-required-"));
  const configPath = path.join(root, "mcp-bridge.json");
  let invoked = false;
  const ui = await launchSetupWizardServer(configPath, { setup: async () => { invoked = true; } });
  t.after(async () => { await ui.close(); await rm(root, { recursive: true, force: true }); });
  const response = await fetch(ui.origin + "/api/setup", {
    method: "POST",
    headers: { Authorization: "Bearer " + ui.token, Origin: ui.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ tunnelId: "tunnel_fixture", runtimeKey: "", healthPort: 8081, reuseClient: false }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /首次配置需要填写 Runtime API key/u);
  assert.equal(invoked, false);
});
test("setup wizard refuses to reconfigure while this Bridge is serving its health endpoint", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-setup-ui-running-"));
  const configPath = path.join(root, "mcp-bridge.json");
  const active = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "chatgpt-mcp-bridge" }));
  });
  active.listen(0, "127.0.0.1");
  await once(active, "listening");
  const address = active.address();
  assert.ok(address && typeof address !== "string");
  const config = JSON.parse(configFileTemplate()) as Record<string, unknown>;
  config.port = address.port;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=existing-key\n");
  let invoked = false;
  const ui = await launchSetupWizardServer(configPath, { setup: async () => { invoked = true; } });
  t.after(async () => {
    await ui.close();
    await new Promise<void>(resolve => active.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(ui.origin + "/api/setup", {
    method: "POST",
    headers: { Authorization: "Bearer " + ui.token, Origin: ui.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ tunnelId: "tunnel_fixture", runtimeKey: "", healthPort: 8081, reuseClient: false }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.text()), /Bridge 仍在运行/u);
  assert.equal(invoked, false);
});