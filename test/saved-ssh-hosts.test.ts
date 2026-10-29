import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SavedSshHostManager } from "../src/terminal/saved-ssh-hosts.js";
import { TerminalSessionManager } from "../src/terminal/terminal-sessions.js";
import { WindowsCredentialVault, type CredentialVault } from "../src/terminal/windows-credential-vault.js";

class FakeVault implements CredentialVault {
  public readonly entries = new Map<string, string>();
  public async save(target: string, _username: string, password: string): Promise<void> {
    this.entries.set(target, password);
  }
  public async read(target: string): Promise<string> {
    const result = this.entries.get(target);
    if (!result) throw new Error("not found");
    return result;
  }
  public async exists(target: string): Promise<boolean> {
    return this.entries.has(target);
  }
  public async delete(target: string): Promise<void> {
    this.entries.delete(target);
  }
}

class FakePty {
  public readonly pid = 4821;
  public readonly writes: string[] = [];
  private readonly listeners = new Set<(value: string) => void>();
  private readonly exits = new Set<(value: { exitCode: number }) => void>();
  public onData(callback: (value: string) => void) {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }
  public onExit(callback: (value: { exitCode: number }) => void) {
    this.exits.add(callback);
    return { dispose: () => this.exits.delete(callback) };
  }
  public write(input: string) {
    this.writes.push(input);
  }
  public emit(output: string) {
    for (const listener of this.listeners) listener(output);
  }
  public kill() {
    for (const listener of this.exits) listener({ exitCode: 0 });
  }
}

test("global SSH host CRUD stores passwords only in the injected credential vault", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-global-hosts-"));
  const metadataPath = path.join(dir, "ssh-hosts.json");
  const vault = new FakeVault();
  const manager = new SavedSshHostManager(metadataPath, vault, async () => "unused");
  try {
    const saved = await manager.saveGlobalFromUi({
      hostId: "pve",
      host: "192.0.2.31",
      username: "root",
      port: 22,
      password: "private-test-password",
    });
    assert.deepEqual(saved, { workspaceId: "global", hostId: "pve", host: "192.0.2.31", username: "root", port: 22 });
    let raw = await readFile(metadataPath, "utf8");
    assert.doesNotMatch(raw, /private-test-password/u);
    assert.equal(vault.entries.get("MCPBridge/SSH/global/pve"), "private-test-password");
    assert.deepEqual(await manager.listGlobal(), [{
      workspaceId: "global", hostId: "pve", host: "192.0.2.31", username: "root", port: 22, credentialAvailable: true,
    }]);

    await manager.saveGlobalFromUi({
      previousHostId: "pve",
      hostId: "pve-main",
      host: "192.0.2.31",
      username: "root",
      port: 2222,
    });
    assert.equal(vault.entries.has("MCPBridge/SSH/global/pve"), false);
    assert.equal(vault.entries.get("MCPBridge/SSH/global/pve-main"), "private-test-password");
    raw = await readFile(metadataPath, "utf8");
    assert.doesNotMatch(raw, /private-test-password/u);
    assert.deepEqual(await manager.removeGlobal("pve-main"), { removed: true });
    assert.equal(vault.entries.has("MCPBridge/SSH/global/pve-main"), false);
    assert.deepEqual(await manager.listGlobal(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("SSH aliases persist across Bridge restarts without storing plaintext passwords", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-alias-test-"));
  const metadataPath = path.join(dir, ".mcp-bridge-state", "ssh-hosts.json");
  const vault = new FakeVault();
  const manager = new SavedSshHostManager(metadataPath, vault, async () => "not-in-metadata");
  try {
    const saved = await manager.save({ workspaceId: "HomeOps-AI", hostId: "pve", host: "192.168.2.31", port: 22, username: "root" });
    assert.equal(saved.saved, true);
    assert.equal(vault.entries.get("MCPBridge/SSH/global/pve"), "not-in-metadata");
    const raw = await readFile(metadataPath, "utf8");
    assert.doesNotMatch(raw, /not-in-metadata/u);
    assert.match(raw, /192\.168\.2\.31/u);
    const restarted = new SavedSshHostManager(metadataPath, vault, async () => null);
    const hosts = await restarted.list("HomeOps-AI");
    assert.equal(hosts.length, 1);
    assert.deepEqual(hosts[0], {
      workspaceId: "HomeOps-AI", hostId: "pve", host: "192.168.2.31",
      port: 22, username: "root", credentialAvailable: true,
    });
    assert.deepEqual(await restarted.list("other"), [{
      workspaceId: "other", hostId: "pve", host: "192.168.2.31",
      port: 22, username: "root", credentialAvailable: true,
    }]);
    await assert.rejects(restarted.save({
      workspaceId: "HomeOps-AI", hostId: "bad", host: "-ProxyCommand=bad", port: 22, username: "root",
    }), /SSH address/u);
    assert.deepEqual(await restarted.remove("HomeOps-AI", "pve"), { removed: true });
    assert.equal(await vault.exists("MCPBridge/SSH/global/pve"), false);
    assert.deepEqual(await restarted.list("HomeOps-AI"), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("saved SSH connects through native ssh.exe and injects the secret only into the PTY after a verified prompt", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-login-test-"));
  const vault = new FakeVault();
  const saved = new SavedSshHostManager(path.join(dir, "hosts.json"), vault, async () => "secret-for-test");
  const pty = new FakePty();
  let launch = { executable: "", args: [] as string[] };
  const terminals = new TerminalSessionManager(async (executable, args) => {
    launch = { executable, args };
    setTimeout(() => pty.emit("\x1b[2Jroot@192.168.2.31's password:\x1b[1C\x1b]0;ssh.exe\x07"), 15);
    return pty;
  });
  try {
    await saved.save({ workspaceId: "HomeOps-AI", hostId: "pve", host: "192.168.2.31", port: 22, username: "root" });
    const session = await saved.connect("another", dir, "pve", terminals);
    assert.equal(session.executable, "ssh.exe");
    assert.equal(launch.executable, "ssh.exe");
    assert.ok(launch.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(launch.args.includes("root@192.168.2.31"));
    assert.ok(launch.args.every((arg) => !arg.includes("secret-for-test")));
    assert.deepEqual(pty.writes, ["secret-for-test\r"]);
    const output = await terminals.read("another", session.sessionId);
    assert.match(output.output, /password:/u);
    assert.equal(output.output.includes("secret-for-test"), false);
    terminals.closeSession("another", session.sessionId);
  } finally {
    terminals.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("saved SSH connects through native OpenSSH on macOS and injects the Keychain secret only after a password prompt", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-mac-login-test-"));
  const vault = new FakeVault();
  const saved = new SavedSshHostManager(path.join(dir, "hosts.json"), vault, async () => "unused");
  const pty = new FakePty();
  let launch = { executable: "", args: [] as string[] };
  const terminals = new TerminalSessionManager(async (executable, args) => {
    launch = { executable, args };
    setTimeout(() => pty.emit("root@192.0.2.31's password:\r\n"), 15);
    return pty;
  });
  try {
    await saved.saveGlobalFromUi({ hostId:"pve", host:"192.0.2.31", port:22, username:"root", password:"secret-for-test" });
    const session = await saved.connect("mac-workspace", dir, "pve", terminals);
    assert.equal(session.executable, "/usr/bin/ssh");
    assert.equal(launch.executable, "/usr/bin/ssh");
    assert.ok(launch.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(launch.args.includes("root@192.0.2.31"));
    assert.ok(launch.args.every(arg => !arg.includes("secret-for-test")));
    assert.deepEqual(pty.writes, ["secret-for-test\r"]);
    const output = await terminals.read("mac-workspace", session.sessionId);
    assert.equal(output.output.includes("secret-for-test"), false);
    terminals.closeSession("mac-workspace", session.sessionId);
  } finally {
    terminals.close();
    await rm(dir, { recursive:true, force:true });
  }
});

test("saved host registration can be canceled without storing a password", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-cancel-test-"));
  const vault = new FakeVault();
  const manager = new SavedSshHostManager(path.join(dir, "hosts.json"), vault, async () => null);
  try {
    const result = await manager.save({ workspaceId: "HomeOps-AI", hostId: "pve", host: "192.168.2.31", username: "root", port: 22 });
    assert.equal(result.saved, false);
    assert.equal(vault.entries.size, 0);
    assert.deepEqual(await manager.list("HomeOps-AI"), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Windows Credential Manager saves, reads and deletes only a disposable test credential", { skip: process.platform !== "win32" }, async () => {
  const vault = new WindowsCredentialVault();
  const key = "MCPBridge/SSH/Test-" + randomBytes(4).toString("hex") + "/roundtrip";
  const temporarySecret = randomBytes(20).toString("hex");
  try {
    await vault.save(key, "test-user", temporarySecret);
    assert.equal(await vault.exists(key), true);
    assert.equal(await vault.read(key), temporarySecret);
  } finally {
    await vault.delete(key).catch(() => undefined);
  }
  assert.equal(await vault.exists(key), false);
});
