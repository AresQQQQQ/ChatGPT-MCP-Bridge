import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DesktopAppLauncher, TrustedDevCommandRunner } from "../src/commands/index.js";
import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("TrustedDevCommandRunner preserves developer context, strips Bridge secrets, and respects cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-exec-"));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const previousControlPlane = process.env.CONTROL_PLANE_API_KEY;
  const previousBridgeToken = process.env.BRIDGE_AUTH_TOKEN;
  const previousVisible = process.env.TRUSTED_DEV_VISIBLE;
  process.env.CONTROL_PLANE_API_KEY = "must-not-leak";
  process.env.BRIDGE_AUTH_TOKEN = "must-not-leak-either";
  process.env.TRUSTED_DEV_VISIBLE = "visible-value";

  try {
    const code = [
      "process.stdout.write(JSON.stringify({",
      "cwd: process.cwd(),",
      "control: process.env.CONTROL_PLANE_API_KEY ?? null,",
      "bridge: process.env.BRIDGE_AUTH_TOKEN ?? null,",
      "visible: process.env.TRUSTED_DEV_VISIBLE ?? null",
      "}))",
    ].join("");
    const result = await new TrustedDevCommandRunner().run({
      type: "exec",
      executable: process.execPath,
      args: ["-e", code],
      cwd: "nested",
    }, root);

    assert.equal(result.outcome, "completed");
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout) as {
      cwd: string;
      control: string | null;
      bridge: string | null;
      visible: string | null;
    };
    assert.equal(path.normalize(payload.cwd), path.normalize(nested));
    assert.equal(payload.control, null);
    assert.equal(payload.bridge, null);
    assert.equal(payload.visible, "visible-value");
  } finally {
    if (previousControlPlane === undefined) delete process.env.CONTROL_PLANE_API_KEY;
    else process.env.CONTROL_PLANE_API_KEY = previousControlPlane;
    if (previousBridgeToken === undefined) delete process.env.BRIDGE_AUTH_TOKEN;
    else process.env.BRIDGE_AUTH_TOKEN = previousBridgeToken;
    if (previousVisible === undefined) delete process.env.TRUSTED_DEV_VISIBLE;
    else process.env.TRUSTED_DEV_VISIBLE = previousVisible;
    await rm(root, { recursive: true, force: true });
  }
});

test("TrustedDevCommandRunner enforces timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-timeout-"));
  try {
    const result = await new TrustedDevCommandRunner().run({
      type: "exec",
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    }, root);
    assert.equal(result.outcome, "timed-out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TrustedDevCommandRunner supports explicit Windows shell execution", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-shell-"));
  try {
    const cmdResult = await new TrustedDevCommandRunner().run({
      type: "shell",
      shell: "cmd",
      command: "echo shell-cmd-ok",
    }, root);
    assert.equal(cmdResult.outcome, "completed");
    assert.match(cmdResult.stdout, /shell-cmd-ok/u);

    const powershellResult = await new TrustedDevCommandRunner().run({
      type: "shell",
      shell: "powershell",
      command: "Write-Output shell-powershell-ok",
    }, root);
    assert.equal(powershellResult.outcome, "completed");
    assert.match(powershellResult.stdout, /shell-powershell-ok/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DesktopAppLauncher returns promptly while the launched process continues independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-desktop-launch-"));
  const marker = path.join(root, "launched.txt");
  try {
    const code = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'desktop-ok'), 200); setTimeout(() => {}, 450)";
    const started = Date.now();
    const result = await new DesktopAppLauncher().launch({
      target: process.execPath,
      args: ["-e", code, marker],
    }, root);
    const elapsed = Date.now() - started;

    assert.ok(result.pid > 0);
    assert.match(result.launchId, /^[0-9a-f-]{36}$/iu);
    assert.ok(elapsed < 200, `launcher should return before child work completes, elapsed=${elapsed}`);
    await waitForFile(marker);
    assert.equal(await readFile(marker, "utf8"), "desktop-ok");
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP trusted developer tools are exposed but permission-gated to trusted-dev workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-mcp-"));
  const workspaceRoot = path.join(base, "workspace");
  const trustedRoot = path.join(base, "trusted");
  await mkdir(workspaceRoot);
  await mkdir(trustedRoot);
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    maxReadBytes: 1024 * 1024,
    workspaces: [
      { id: "workspace", root: workspaceRoot, mode: "workspace" },
      { id: "trusted", root: trustedRoot, mode: "trusted-dev" },
    ],
    configPath: path.join(base, "bridge.json"),
  };

  const bridge = await createBridgeApp(config);
  const server = http.createServer(bridge.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
  const client = new Client({ name: "trusted-dev-test", version: "0.1.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "exec_dev_command"));
    assert.ok(tools.tools.some((tool) => tool.name === "launch_desktop_app"));

    const deniedExec = await client.callTool({
      name: "exec_dev_command",
      arguments: {
        workspaceId: "workspace",
        type: "exec",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('should-not-run')"],
      },
    });
    assert.equal(deniedExec.isError, true);

    const deniedLaunch = await client.callTool({
      name: "launch_desktop_app",
      arguments: {
        workspaceId: "workspace",
        target: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    });
    assert.equal(deniedLaunch.isError, true);

    const allowedExec = await client.callTool({
      name: "exec_dev_command",
      arguments: {
        workspaceId: "trusted",
        type: "exec",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('trusted-mcp-ok')"],
      },
    });
    assert.equal(allowedExec.isError, undefined);
    const text = allowedExec.content[0]?.type === "text" ? allowedExec.content[0].text : "";
    assert.match(text, /trusted-mcp-ok/u);
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    await rm(base, { recursive: true, force: true });
  }
});
