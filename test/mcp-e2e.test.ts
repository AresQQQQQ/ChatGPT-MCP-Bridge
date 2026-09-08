import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";

const execFileAsync = promisify(execFile);

test("MCP end to end: open, read, run, patch, and inspect git diff", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), ".mcp-e2e-"));
  const sourcePath = path.join(fixtureRoot, "example.ts");
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  let bridge: Awaited<ReturnType<typeof createBridgeApp>> | undefined;
  let server: http.Server | undefined;
  let client: Client | undefined;

  try {
    await writeFile(sourcePath, "export const answer = 1;\n", "utf8");
    await writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"process.stdout.write('e2e-command-ok')\"",
          fail: "node -e \"process.exit(2)\"",
        },
      }),
      "utf8",
    );
    await writeFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "MCP Bridge Test"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["add", "--", "example.ts", "package.json", "pnpm-lock.yaml"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixtureRoot, windowsHide: true });

    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      maxReadBytes: 1024 * 1024,
      auth: { token },
      workspaces: [{ id: "demo", root: fixtureRoot, mode: "workspace", allowedScripts: ["test", "fail"] }],
      configPath: path.join(fixtureRoot, "mcp-bridge.json"),
    };
    bridge = await createBridgeApp(config);
    server = http.createServer(bridge.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");

    client = new Client({ name: "mcp-bridge-e2e", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);

    const opened = await client.callTool({ name: "open_workspace", arguments: { workspaceId: "demo" } });
    assert.equal(opened.isError, undefined);

    const read = await client.callTool({ name: "read_file", arguments: { workspaceId: "demo", path: "example.ts" } });
    assert.equal(read.content[0]?.type, "text");
    assert.equal(read.content[0]?.text, "export const answer = 1;\n");

    const command = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId: "demo", kind: "test" },
    });
    assert.equal(command.isError, undefined);
    assert.match(command.content[0]?.type === "text" ? command.content[0].text : "", /e2e-command-ok/u);

    const failedCommand = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId: "demo", kind: "package-script", name: "fail" },
    });
    assert.equal(failedCommand.isError, true);
    assert.equal((failedCommand.structuredContent as { outcome?: string } | undefined)?.outcome, "failed");

    const patched = await client.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: "demo",
        path: "example.ts",
        patch: { hunks: [{ oldText: "answer = 1", newText: "answer = 42" }] },
      },
    });
    assert.equal(patched.isError, undefined);

    const diff = await client.callTool({ name: "git_diff", arguments: { workspaceId: "demo", path: "example.ts" } });
    assert.equal(diff.isError, undefined);
    assert.equal(diff.content[0]?.type, "text");
    assert.match(diff.content[0]?.text ?? "", /\+export const answer = 42;/u);
  } finally {
    await client?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
