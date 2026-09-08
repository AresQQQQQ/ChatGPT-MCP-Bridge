import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";

const execFileAsync = promisify(execFile);

test("workspace authorization is request-scoped across independent MCP sessions", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), ".mcp-session-"));
  const sourcePath = path.join(fixtureRoot, "example.ts");
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  let bridge: Awaited<ReturnType<typeof createBridgeApp>> | undefined;
  let server: http.Server | undefined;
  let sessionA: Client | undefined;
  let sessionB: Client | undefined;

  try {
    await writeFile(sourcePath, "export const needle = 1;\n", "utf8");
    await writeFile(path.join(fixtureRoot, "notes.txt"), "needle appears here\n", "utf8");
    await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    await writeFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "MCP Bridge Session Test"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "bridge-session@example.invalid"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["add", "--", "example.ts", "notes.txt", "package.json", "pnpm-lock.yaml"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixtureRoot, windowsHide: true });

    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      maxReadBytes: 1024 * 1024,
      auth: { token },
      workspaces: [
        { id: "demo", root: fixtureRoot, mode: "workspace", allowedScripts: [] },
        { id: "readonly-demo", root: fixtureRoot, mode: "readonly" },
        { id: "handoff-demo", root: fixtureRoot, mode: "handoff" },
      ],
      configPath: path.join(fixtureRoot, "mcp-bridge.json"),
    };
    bridge = await createBridgeApp(config);
    server = http.createServer(bridge.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

    sessionA = new Client({ name: "mcp-session-a", version: "0.1.0" });
    await sessionA.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const opened = await sessionA.callTool({ name: "open_workspace", arguments: { workspaceId: "demo" } });
    assert.equal(opened.isError, undefined);

    sessionB = new Client({ name: "mcp-session-b", version: "0.1.0" });
    await sessionB.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));

    const listed = await sessionB.callTool({
      name: "list_directory",
      arguments: { workspaceId: "demo", path: "." },
    });
    assert.equal(listed.isError, undefined);

    const read = await sessionB.callTool({
      name: "read_file",
      arguments: { workspaceId: "demo", path: "example.ts" },
    });
    assert.equal(read.isError, undefined);
    assert.equal(read.content[0]?.type, "text");
    assert.equal(read.content[0]?.text, "export const needle = 1;\n");

    const search = await sessionB.callTool({
      name: "search",
      arguments: { workspaceId: "demo", query: "needle", path: ".", includeContent: true },
    });
    assert.equal(search.isError, undefined);
    assert.match(search.content[0]?.type === "text" ? search.content[0].text : "", /example\.ts/u);

    const status = await sessionB.callTool({
      name: "git_status",
      arguments: { workspaceId: "demo" },
    });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { outcome?: string } | undefined)?.outcome, "completed");

    const patched = await sessionB.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: "demo",
        path: "example.ts",
        patch: { hunks: [{ oldText: "needle = 1", newText: "needle = 42" }] },
      },
    });
    assert.equal(patched.isError, undefined);
    assert.equal(await readFile(sourcePath, "utf8"), "export const needle = 42;\n");

    const diff = await sessionB.callTool({
      name: "git_diff",
      arguments: { workspaceId: "demo", path: "example.ts" },
    });
    assert.equal(diff.isError, undefined);
    assert.match(diff.content[0]?.type === "text" ? diff.content[0].text : "", /needle = 42/u);

    const readonlyPatch = await sessionB.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: "readonly-demo",
        path: "example.ts",
        patch: { hunks: [{ oldText: "needle = 42", newText: "needle = 43" }] },
      },
    });
    const handoffWrite = await sessionB.callTool({
      name: "write_file",
      arguments: { workspaceId: "handoff-demo", path: "handoff.txt", content: "denied\n" },
    });
    const readonlyExec = await sessionB.callTool({
      name: "exec_command",
      arguments: { workspaceId: "readonly-demo", kind: "test" },
    });
    for (const result of [readonlyPatch, handoffWrite, readonlyExec]) {
      assert.equal(result.isError, true);
    }
    assert.equal(await readFile(sourcePath, "utf8"), "export const needle = 42;\n");

    const unknownRead = await sessionB.callTool({
      name: "read_file",
      arguments: { workspaceId: "does-not-exist", path: "example.ts" },
    });
    const unknownList = await sessionB.callTool({
      name: "list_directory",
      arguments: { workspaceId: "does-not-exist", path: "." },
    });
    const unknownSearch = await sessionB.callTool({
      name: "search",
      arguments: { workspaceId: "does-not-exist", query: "needle" },
    });
    const unknownStatus = await sessionB.callTool({
      name: "git_status",
      arguments: { workspaceId: "does-not-exist" },
    });
    const unknownPatch = await sessionB.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: "does-not-exist",
        path: "example.ts",
        patch: { hunks: [{ oldText: "needle = 42", newText: "needle = 43" }] },
      },
    });
    const unknownDiff = await sessionB.callTool({
      name: "git_diff",
      arguments: { workspaceId: "does-not-exist" },
    });
    const unknownExec = await sessionB.callTool({
      name: "exec_command",
      arguments: { workspaceId: "does-not-exist", kind: "test" },
    });
    for (const result of [
      unknownRead,
      unknownList,
      unknownSearch,
      unknownStatus,
      unknownPatch,
      unknownDiff,
      unknownExec,
    ]) {
      assert.equal(result.isError, true);
    }
  } finally {
    await sessionB?.close().catch(() => undefined);
    await sessionA?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
