import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";
import { PASSWORD_UI_SCRIPT } from "../src/terminal/local-password-prompt.js";
import { TerminalSessionManager, type PtySpawner } from "../src/terminal/terminal-sessions.js";

class FakePty {
  public readonly pid = 1234;
  public readonly inputs: string[] = [];
  public killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(data: { exitCode: number; signal?: number }) => void>();
  public onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  public onExit(listener: (data: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  public write(data: string) { this.inputs.push(data); }
  public kill() {
    this.killed = true;
    for (const cb of this.exitListeners) cb({ exitCode: 0 });
  }
  public emit(data: string) {
    for (const cb of this.dataListeners) cb(data);
  }
}

test("PTY manager retains output cursors and enforces workspace isolation", async () => {
  const fake = new FakePty();
  const spawn: PtySpawner = async () => fake;
  const manager = new TerminalSessionManager(spawn);
  try {
    const session = await manager.start("allowed", process.cwd(), { executable: "cmd.exe" });
    assert.equal(session.state, "running");
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/u);
    fake.emit("first");
    const first = await manager.read("allowed", session.sessionId);
    assert.equal(first.output, "first");
    fake.emit("-second");
    const second = await manager.read("allowed", session.sessionId, first.nextCursor);
    assert.equal(second.output, "-second");
    assert.equal(second.truncated, false);
    assert.equal(manager.write("allowed", session.sessionId, "hello\r").written, true);
    assert.deepEqual(fake.inputs, ["hello\r"]);
    await assert.rejects(manager.read("another", session.sessionId), /not found/u);
    assert.throws(() => manager.write("another", session.sessionId, "no"), /not found/u);
    assert.throws(() => manager.closeSession("another", session.sessionId), /not found/u);
    const closed = manager.closeSession("allowed", session.sessionId);
    assert.equal(fake.killed, true);
    assert.equal(closed.state, "exited");
  } finally {
    manager.close();
  }
});

test("PTY output is bounded and old cursors report truncation", async () => {
  const fake = new FakePty();
  const manager = new TerminalSessionManager(async () => fake);
  try {
    const session = await manager.start("trusted", process.cwd(), { executable: "cmd.exe" });
    fake.emit("X".repeat(300 * 1024));
    const first = await manager.read("trusted", session.sessionId, 0);
    assert.equal(first.truncated, true);
    assert.equal(first.output.length, 32 * 1024);
    let next = first.nextCursor;
    let received = first.output.length;
    while (true) {
      const chunk = await manager.read("trusted", session.sessionId, next);
      if (!chunk.output) break;
      received += chunk.output.length;
      next = chunk.nextCursor;
    }
    assert.equal(received, 256 * 1024);
  } finally {
    manager.close();
  }
});

test("local SSH password prompt sends secret to PTY without returning it to the tool", async () => {
  const fake = new FakePty();
  let prompted = 0;
  const manager = new TerminalSessionManager(async () => fake, async () => {
    prompted++;
    return "unit-test-secret";
  });
  try {
    const session = await manager.start("trusted", process.cwd(), { executable: "ssh.exe" });
    await assert.rejects(manager.localPassword("trusted", session.sessionId), /No recent SSH password/u);
    fake.emit("root@host's password:");
    const result = await manager.localPassword("trusted", session.sessionId);
    assert.deepEqual(result, { submitted: true });
    assert.equal(prompted, 1);
    assert.deepEqual(fake.inputs, ["unit-test-secret\r"]);
    assert.equal(JSON.stringify(result).includes("unit-test-secret"), false);
    const output = await manager.read("trusted", session.sessionId);
    assert.equal(output.output.includes("unit-test-secret"), false);
  } finally {
    manager.close();
  }
});

test("concurrent PTY starts enforce the per-workspace reservation limit", async () => {
  const spawned: FakePty[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new TerminalSessionManager(async () => {
    await gate;
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  });
  try {
    const pending = Array.from({ length: 4 }, () => manager.start("trusted", process.cwd(), { executable: "cmd.exe" }));
    await assert.rejects(
      manager.start("trusted", process.cwd(), { executable: "cmd.exe" }),
      /Too many active terminal sessions/u,
    );
    release?.();
    const sessions = await Promise.all(pending);
    assert.equal(sessions.length, 4);
    assert.equal(spawned.length, 4);
  } finally {
    release?.();
    manager.close();
  }
});

test("Windows local password dialog script has valid PowerShell syntax", { skip: process.platform !== "win32" }, () => {
  // Only parse the script. Do not open a window or request a real password in CI.
  const source = Buffer.from(PASSWORD_UI_SCRIPT, "utf16le").toString("base64");
  const script = [
    "$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + source + "'))",
    "$tokens = $null",
    "$errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count -gt 0) { throw 'Password UI syntax invalid' }",
    "Write-Output 'PROMPT_SYNTAX_OK'",
  ].join("; ");
  const checked = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.match(checked, /PROMPT_SYNTAX_OK/u);
});

test("MCP PTY terminal keeps working across stateless HTTP requests", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-pty-test-"));
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    maxReadBytes: 1024 * 1024,
    workspaces: [
      { id: "trusted", root, mode: "trusted-dev" },
      { id: "readonly", root, mode: "readonly" },
    ],
    configPath: path.join(root, "bridge.json"),
  };
  const bridge = await createBridgeApp(config);
  const server = http.createServer(bridge.app);
  const client = new Client({ name: "pty-test", version: "0.1.0" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + address.port + "/mcp")));
    const tools = await client.listTools();
    for (const name of ["terminal_start", "terminal_read", "terminal_write", "terminal_local_password", "terminal_list", "terminal_close"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), name + " missing");
    }
    const denied = await client.callTool({
      name: "terminal_start",
      arguments: { workspaceId: "readonly", executable: "cmd.exe" },
    });
    assert.equal(denied.isError, true);
    const started = await client.callTool({
      name: "terminal_start",
      arguments: { workspaceId: "trusted", executable: "cmd.exe", args: ["/d", "/q"] },
    });
    assert.equal(started.isError, undefined);
    const sessionId = (started.structuredContent as { sessionId: string }).sessionId;
    assert.ok(sessionId);

    const sent = await client.callTool({
      name: "terminal_write",
      arguments: { workspaceId: "trusted", sessionId, input: "echo BRIDGE_PTY_SMOKE\r" },
    });
    assert.equal(sent.isError, undefined);
    let output = "";
    let cursor = 0;
    for (let i = 0; i < 12 && !output.includes("BRIDGE_PTY_SMOKE"); i++) {
      const received = await client.callTool({
        name: "terminal_read",
        arguments: { workspaceId: "trusted", sessionId, cursor, waitMs: 1000 },
      });
      assert.equal(received.isError, undefined);
      const data = received.structuredContent as { output: string; nextCursor: number };
      output += data.output;
      cursor = data.nextCursor;
    }
    assert.match(output, /BRIDGE_PTY_SMOKE/u);
    const closed = await client.callTool({
      name: "terminal_close",
      arguments: { workspaceId: "trusted", sessionId },
    });
    assert.equal(closed.isError, undefined);
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close();
    server.close();
    if (server.listening) await once(server, "close");
    // Windows ConPTY may release its last file handle slightly after process exit.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
