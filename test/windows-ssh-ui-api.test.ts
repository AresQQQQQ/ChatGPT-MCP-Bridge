import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SavedSshHostManager } from "../src/terminal/saved-ssh-hosts.js";
import type { CredentialVault } from "../src/terminal/windows-credential-vault.js";
import { launchWindowsSshUiApi } from "../src/ui/windows-ssh-ui-api.js";

class MemoryVault implements CredentialVault {
  readonly secrets = new Map<string, { username: string; password: string }>();
  async save(target: string, username: string, password: string) { this.secrets.set(target, { username, password }); }
  async read(target: string) { const entry = this.secrets.get(target); if (!entry) throw new Error("missing"); return entry.password; }
  async exists(target: string) { return this.secrets.has(target); }
  async delete(target: string) { this.secrets.delete(target); }
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-ssh-settings-ui-"));
  const configPath = path.join(root, "mcp-bridge.json");
  const statePath = path.join(root, ".mcp-bridge-state", "ssh-hosts.json");
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1", port: 39990,
    workspaces: [
      { id: "dev", root, mode: "trusted-dev", allowedScripts: [] },
      { id: "dev-two", root, mode: "trusted-dev", allowedScripts: [] },
      { id: "read", root, mode: "readonly", allowedScripts: [] },
    ],
  }));
  const vault = new MemoryVault();
  const manager = new SavedSshHostManager(statePath, vault, async () => { throw new Error("must not open a password dialog"); });
  const api = await launchWindowsSshUiApi(configPath, { manager });
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  async function request(route: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(api.origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + api.token,
        ...(body === undefined ? {} : { Origin: api.origin, "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    return { code: response.status, result, response };
  }
  return { root, configPath, statePath, vault, manager, api, request };
}

test("legacy per-Workspace SSH hosts migrate to one global list and retain passwords", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-ssh-global-migration-"));
  const statePath = path.join(root, "ssh-hosts.json");
  const vault = new MemoryVault();
  const legacy = [
    { workspaceId: "HomeOps-AI", hostId: "pve", host: "192.0.2.21", username: "root", port: 22 },
    { workspaceId: "bridge", hostId: "pve", host: "192.0.2.31", username: "admin", port: 2222 },
  ];
  vault.secrets.set("MCPBridge/SSH/HomeOps-AI/pve", { username: "root", password: "legacy-one-fixture" });
  vault.secrets.set("MCPBridge/SSH/bridge/pve", { username: "admin", password: "legacy-two-fixture" });
  await writeFile(statePath, JSON.stringify({ version: 1, hosts: legacy }));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const manager = new SavedSshHostManager(statePath, vault);
  const hosts = await manager.listGlobal();
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts.map(host => host.hostId).sort(), ["pve", "pve-bridge"]);
  assert.ok(hosts.every(host => host.workspaceId === "global" && host.credentialAvailable));
  assert.equal(vault.secrets.get("MCPBridge/SSH/global/pve")?.password, "legacy-one-fixture");
  assert.equal(vault.secrets.get("MCPBridge/SSH/global/pve-bridge")?.password, "legacy-two-fixture");
  assert.equal(vault.secrets.has("MCPBridge/SSH/HomeOps-AI/pve"), false);
  assert.equal(vault.secrets.has("MCPBridge/SSH/bridge/pve"), false);
  const saved = await readFile(statePath, "utf8");
  assert.doesNotMatch(saved, /legacy-one-fixture|legacy-two-fixture/u);
  assert.ok(JSON.parse(saved).hosts.every((host: { workspaceId: string }) => host.workspaceId === "global"));
  assert.deepEqual((await manager.list("dev")).map(host => host.workspaceId), ["dev", "dev"]);
  assert.deepEqual((await manager.list("dev-two")).map(host => host.hostId).sort(), ["pve", "pve-bridge"]);
});

test("Windows local SSH UI API authenticates, checks Origin, and exposes a global list", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.api.origin + "/api/ssh/hosts")).status, 401);
  assert.equal((await f.request("/api/ssh/hosts", undefined, { Authorization: "Bearer wrong" })).code, 401);
  assert.equal((await f.request("/api/ssh/hosts", undefined, { Origin: "http://evil.invalid" })).code, 403);
  assert.deepEqual((await f.request("/api/ssh/hosts")).result.hosts, []);
  assert.equal((await f.request("/api/ssh/save", { hostId: "pve", host: "192.0.2.21", port: 22, username: "root", password: "test-only", unexpected: true })).code, 400);
  assert.equal((await f.request("/api/ssh/save", { hostId: "pve", host: "192.0.2.21", port: 22, username: "root" })).code, 400);
  assert.equal((await f.request("/api/ssh/save", { workspaceId: "read", hostId: "pve", host: "192.0.2.21", port: 22, username: "root", password: "test-only" })).code, 400);
  assert.equal(f.vault.secrets.size, 0);
});

test("SSH UI adds, edits, renames, changes password and deletes hosts globally", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const initial = { hostId: "pve", host: "192.0.2.21", port: 22, username: "root", password: "secret-one-fixture" };
  const saved = await f.request("/api/ssh/save", initial);
  assert.equal(saved.code, 200);
  assert.equal(saved.result.saved, true);
  assert.equal(saved.result.host.password, undefined);
  const key = "MCPBridge/SSH/global/pve";
  assert.deepEqual(f.vault.secrets.get(key), { username: "root", password: "secret-one-fixture" });
  assert.equal((await f.request("/api/ssh/save", { ...initial, host: "192.0.2.99", password: "unexpected-overwrite" })).code, 400);
  assert.equal(f.vault.secrets.get(key)?.password, "secret-one-fixture");
  assert.doesNotMatch(await readFile(f.statePath, "utf8"), /secret-one-fixture/u);

  const otherManager = new SavedSshHostManager(f.statePath, f.vault);
  assert.equal((await otherManager.list("dev"))[0].hostId, "pve");
  const updated = await f.request("/api/ssh/save", {
    previousHostId: "pve", hostId: "prod-pve", host: "192.0.2.33", port: 2222, username: "admin",
  });
  assert.equal(updated.code, 200);
  const renamedKey = "MCPBridge/SSH/global/prod-pve";
  assert.equal(f.vault.secrets.has(key), false);
  assert.deepEqual(f.vault.secrets.get(renamedKey), { username: "admin", password: "secret-one-fixture" });
  const allHosts = await f.request("/api/ssh/hosts");
  assert.equal(allHosts.code, 200);
  assert.deepEqual(allHosts.result.hosts, [{
    workspaceId: "global", hostId: "prod-pve", host: "192.0.2.33", port: 2222,
    username: "admin", credentialAvailable: true,
  }]);

  assert.equal((await f.request("/api/ssh/save", {
    previousHostId: "prod-pve", hostId: "prod-pve",
    host: "192.0.2.33", port: 2222, username: "admin", password: "secret-two-fixture",
  })).code, 200);
  assert.equal(f.vault.secrets.get(renamedKey)?.password, "secret-two-fixture");
  const persisted = await readFile(f.statePath, "utf8");
  assert.doesNotMatch(persisted, /secret-one-fixture|secret-two-fixture/u);
  assert.equal((await otherManager.list("dev-two"))[0].host, "192.0.2.33");

  const removed = await f.request("/api/ssh/remove", { hostId: "prod-pve" });
  assert.equal(removed.code, 200);
  assert.equal(removed.result.removed, true);
  assert.equal(f.vault.secrets.size, 0);
  assert.deepEqual(await otherManager.list("dev"), []);
});

test("Windows WPF settings group API/ports, global SSH and Codex without putting SSH passwords in command files", async () => {
  const ui = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  assert.match(ui, /TabItem Header="API \/ 端口"/u);
  assert.match(ui, /TabItem Header="SSH 主机"/u);
  assert.match(ui, /TabItem Header="Codex 默认值"/u);
  assert.match(ui, /x:Name="ConnectionWizardButton"/u);
  assert.match(ui, /x:Name="ConnectionSetupPopup"/u);
  assert.match(ui, /PasswordBox x:Name="SshPasswordBox"/u);
  assert.match(ui, /Invoke-SshUi '\/api\/ssh\/save' 'POST'/u);
  assert.match(ui, /BRIDGE_SSH_UI_TOKEN:sshUiApi\.token/u);
  assert.doesNotMatch(ui, /SshWorkspaceBox/u);
  assert.doesNotMatch(ui, /Password=.*CommandPath|ConfigEditPath.*SshPassword/u);
});
