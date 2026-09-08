import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";

const execFileAsync = promisify(execFile);

test("Codex-enabled workspaces expose the bounded Codex MCP tools without changing the base tool surface", async () => {
  const tempRoot = await mkdtemp(path.join(process.cwd(), ".mcp-bridge-codex-http-"));
  let bridge: Awaited<ReturnType<typeof createBridgeApp>> | undefined;
  let server: http.Server | undefined;
  let client: Client | undefined;
  try {
    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      maxReadBytes: 1024,
      workspaces: [{
        id: "demo",
        root: tempRoot,
        mode: "workspace",
        codex: { enabled: true, modules: { media: "Media / PDF" } },
      }],
      configPath: path.join(tempRoot, "mcp-bridge.json"),
    };
    await writeFile(config.configPath, `${JSON.stringify({
      host: config.host,
      port: config.port,
      mcpPath: config.mcpPath,
      maxReadBytes: config.maxReadBytes,
      workspaces: config.workspaces,
    }, null, 2)}\n`, "utf8");
    bridge = await createBridgeApp(config);
    server = http.createServer(bridge.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not expose an address");

    client = new Client({ name: "codex-tool-contract", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 62);
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "codex_get_status",
      "codex_list_modules",
      "codex_create_module",
      "codex_update_module",
      "codex_delete_module",
      "codex_list_threads",
      "codex_read_thread",
      "codex_submit_task",
      "codex_get_task",
      "codex_continue_task",
      "codex_cancel_task",
    ]) assert.equal(names.has(name), true, `${name} is exposed`);

    const modulesTool = tools.tools.find((tool) => tool.name === "codex_list_modules");
    assert.ok(modulesTool);
    assert.match(modulesTool.description ?? "", /single current Codex thread binding/u);
    const submit = tools.tools.find((tool) => tool.name === "codex_submit_task");
    assert.ok(submit);
    assert.match(submit.description ?? "", /gpt-5\.6-luna.*reasoning effort max/u);
    assert.match(submit.description ?? "", /at most one current thread binding/u);
    const continueTool = tools.tools.find((tool) => tool.name === "codex_continue_task");
    assert.ok(continueTool);
    assert.match(continueTool.description ?? "", /module's current unarchived binding/u);
    const submitProperties = (submit.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal("workspaceId" in submitProperties, true);
    assert.equal("moduleId" in submitProperties, true);
    assert.equal("instruction" in submitProperties, true);
    assert.equal("model" in submitProperties, true);
    assert.equal("effort" in submitProperties, true);
    assert.equal("requestId" in submitProperties, true);
    assert.equal("cwd" in submitProperties, false);
    assert.equal("sandbox" in submitProperties, false);
    assert.equal("approvalPolicy" in submitProperties, false);

    const modules = await client.callTool({ name: "codex_list_modules", arguments: { workspaceId: "demo" } });
    assert.equal(modules.isError, undefined);
    assert.match(modules.content[0]?.type === "text" ? modules.content[0].text : "", /Media \/ PDF/u);

    const created = await client.callTool({
      name: "codex_create_module",
      arguments: { workspaceId: "demo", moduleId: "release", displayName: "Release" },
    });
    assert.equal(created.isError, undefined);
    assert.match(created.content[0]?.type === "text" ? created.content[0].text : "", /"moduleId":"release"/u);
    const renamed = await client.callTool({
      name: "codex_update_module",
      arguments: { workspaceId: "demo", moduleId: "release", displayName: "Shipping" },
    });
    assert.equal(renamed.isError, undefined);
    assert.match(renamed.content[0]?.type === "text" ? renamed.content[0].text : "", /\[ChatGPT\] Shipping/u);
    const deleted = await client.callTool({
      name: "codex_delete_module",
      arguments: { workspaceId: "demo", moduleId: "release" },
    });
    assert.equal(deleted.isError, undefined);
    assert.match(deleted.content[0]?.type === "text" ? deleted.content[0].text : "", /"deleted":true/u);
  } finally {
    await client?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    if (server) {
      server.close();
      if (server.listening) await once(server, "close");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Express endpoint completes MCP handshake and exposes the file tools", async () => {
  const tempRoot = await mkdtemp(path.join(process.cwd(), ".mcp-bridge-http-"));
  try {
    await writeFile(path.join(tempRoot, "readme.txt"), "hello over MCP", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd: tempRoot, windowsHide: true });
    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      maxReadBytes: 1024,
      workspaces: [{
        id: "demo",
        root: tempRoot,
        recipes: {
          smoke: {
            description: "Recipe smoke test",
            executable: process.execPath,
            args: ["-e", "process.stdout.write('recipe-http-ok')"],
          },
        },
      }],
      configPath: path.join(tempRoot, "mcp-bridge.json"),
    };
    const bridge = await createBridgeApp(config);
    const server = http.createServer(bridge.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address === "string") throw new Error("server did not expose an address");

    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const client = new Client({ name: "bridge-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "apply_patch",
        "compare_tree",
        "compare_worktree_checkpoint",
        "copy_file",
        "copy_tree",
        "create_directory",
        "create_worktree_checkpoint",
        "delete_directory",
        "delete_file",
        "download_file",
        "exec_command",
        "exec_dev_command",
        "exec_recipe",
        "execute_file_plan",
        "extract_pdf_text",
        "find_files",
        "find_processes",
        "get_image",
        "get_pdf_info",
        "get_workspace_info",
        "git_add",
        "git_commit",
        "git_diff",
        "git_init",
        "git_log",
        "git_show",
        "git_status",
        "inspect_process",
        "launch_desktop_app",
        "list_directory",
        "list_recipes",
        "list_workspaces",
        "mcp_call_tool",
        "mcp_list_tools",
        "mcp_server_list",
        "mcp_server_load",
        "mcp_server_probe",
        "mcp_server_unload",
        "mkdir_p",
        "move_path",
        "open_workspace",
        "prepare_file_plan",
        "read_file",
        "read_files",
        "render_pdf_page",
        "search",
        "snapshot_tree",
        "stat_file",
        "stat_files",
        "wait_process",
        "write_file",
      ]);

      const recipeList = await client.callTool({ name: "list_recipes", arguments: { workspaceId: "demo" } });
      assert.equal(recipeList.isError, undefined);
      assert.match(recipeList.content[0]?.type === "text" ? recipeList.content[0].text : "", /smoke/u);
      assert.doesNotMatch(recipeList.content[0]?.type === "text" ? recipeList.content[0].text : "", /process\.execPath|process\.stdout/u);

      const recipeRun = await client.callTool({ name: "exec_recipe", arguments: { workspaceId: "demo", recipeId: "smoke" } });
      assert.equal(recipeRun.isError, undefined);
      assert.match(recipeRun.content[0]?.type === "text" ? recipeRun.content[0].text : "", /recipe-http-ok/u);
      const recipeStructured = recipeRun.structuredContent as Record<string, unknown>;
      assert.equal(recipeStructured.recipeId, "smoke");
      assert.equal(recipeStructured.outcome, "completed");

      const recipeInjection = await client.callTool({
        name: "exec_recipe",
        arguments: { workspaceId: "demo", recipeId: "smoke", args: ["--unsafe"] },
      });
      assert.equal(recipeInjection.isError, true);

      if (process.platform === "win32") {
        const inspected = await client.callTool({
          name: "inspect_process",
          arguments: { workspaceId: "demo", pid: process.pid },
        });
        assert.equal(inspected.isError, undefined);
        const inspectedStructured = inspected.structuredContent as { found?: boolean; process?: { pid?: number; name?: string } };
        assert.equal(inspectedStructured.found, true);
        assert.equal(inspectedStructured.process?.pid, process.pid);

        const foundProcesses = await client.callTool({
          name: "find_processes",
          arguments: { workspaceId: "demo", name: inspectedStructured.process?.name },
        });
        assert.equal(foundProcesses.isError, undefined);

        const waited = await client.callTool({
          name: "wait_process",
          arguments: { workspaceId: "demo", pid: process.pid, timeoutMs: 100, pollMs: 100 },
        });
        assert.equal(waited.isError, undefined);
        assert.equal((waited.structuredContent as Record<string, unknown>).exited, false);
      }

      const mkdirTree = await client.callTool({
        name: "mkdir_p",
        arguments: { workspaceId: "demo", path: "mcp-plan/nested" },
      });
      assert.equal(mkdirTree.isError, undefined);

      await writeFile(path.join(tempRoot, "plan-source.txt"), "plan", "utf8");
      const preparedPlan = await client.callTool({
        name: "prepare_file_plan",
        arguments: {
          workspaceId: "demo",
          operations: [{
            kind: "copy",
            sourcePath: "plan-source.txt",
            targetPath: "mcp-plan/nested/copied.txt",
          }],
        },
      });
      assert.equal(preparedPlan.isError, undefined);
      const preparedStructured = preparedPlan.structuredContent as Record<string, unknown>;
      assert.equal(typeof preparedStructured.planId, "string");
      const executedPlan = await client.callTool({
        name: "execute_file_plan",
        arguments: { workspaceId: "demo", planId: preparedStructured.planId },
      });
      assert.equal(executedPlan.isError, undefined);
      assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(tempRoot, "mcp-plan", "nested", "copied.txt"), "utf8")), "plan");

      await mkdir(path.join(tempRoot, "tree-source"));
      await writeFile(path.join(tempRoot, "tree-source", "a.txt"), "A", "utf8");
      const copiedTree = await client.callTool({
        name: "copy_tree",
        arguments: { workspaceId: "demo", sourcePath: "tree-source", targetPath: "tree-target" },
      });
      assert.equal(copiedTree.isError, undefined);
      assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(tempRoot, "tree-target", "a.txt"), "utf8")), "A");

      const batchRead = await client.callTool({
        name: "read_files",
        arguments: { workspaceId: "demo", paths: ["readme.txt", "plan-source.txt"] },
      });
      assert.equal(batchRead.isError, undefined);
      const batchReadStructured = batchRead.structuredContent as { totalBytes?: number };
      assert.equal(batchReadStructured.totalBytes, "hello over MCP".length + "plan".length);

      const batchStat = await client.callTool({
        name: "stat_files",
        arguments: { workspaceId: "demo", paths: ["readme.txt", "plan-source.txt"], includeHash: true },
      });
      assert.equal(batchStat.isError, undefined);

      const sourceSnapshot = await client.callTool({
        name: "snapshot_tree",
        arguments: { workspaceId: "demo", path: "tree-source", includeHash: true },
      });
      const targetSnapshot = await client.callTool({
        name: "snapshot_tree",
        arguments: { workspaceId: "demo", path: "tree-target", includeHash: true },
      });
      assert.equal(sourceSnapshot.isError, undefined);
      assert.equal(targetSnapshot.isError, undefined);
      const sourceSnapshotId = (sourceSnapshot.structuredContent as Record<string, unknown>).snapshotId;
      const targetSnapshotId = (targetSnapshot.structuredContent as Record<string, unknown>).snapshotId;
      const comparedTree = await client.callTool({
        name: "compare_tree",
        arguments: {
          workspaceId: "demo",
          leftSnapshotId: sourceSnapshotId,
          rightSnapshotId: targetSnapshotId,
        },
      });
      assert.equal(comparedTree.isError, undefined);
      const comparedStructured = comparedTree.structuredContent as Record<string, unknown>;
      assert.equal(comparedStructured.comparisonMode, "sha256");
      assert.deepEqual(comparedStructured.changed, []);
      assert.deepEqual(comparedStructured.missingLeft, []);
      assert.deepEqual(comparedStructured.missingRight, []);

      const checkpoint = await client.callTool({
        name: "create_worktree_checkpoint",
        arguments: { workspaceId: "demo" },
      });
      assert.equal(checkpoint.isError, undefined);
      const checkpointId = (checkpoint.structuredContent as Record<string, unknown>).checkpointId;
      assert.equal(typeof checkpointId, "string");
      const changedByTask = await client.callTool({
        name: "write_file",
        arguments: { workspaceId: "demo", path: "plan-source.txt", content: "plan-changed" },
      });
      assert.equal(changedByTask.isError, undefined);
      const checkpointComparison = await client.callTool({
        name: "compare_worktree_checkpoint",
        arguments: { workspaceId: "demo", checkpointId },
      });
      assert.equal(checkpointComparison.isError, undefined);
      const checkpointStructured = checkpointComparison.structuredContent as { preExistingAdditionallyModified?: string[] };
      assert.equal(checkpointStructured.preExistingAdditionallyModified?.includes("plan-source.txt"), true);

      const unopened = await client.callTool({
        name: "read_file",
        arguments: { workspaceId: "demo", path: "readme.txt" },
      });
      assert.equal(unopened.isError, undefined);
      assert.equal(unopened.content[0]?.type, "text");
      assert.equal(unopened.content[0]?.text, "hello over MCP");

      const opened = await client.callTool({ name: "open_workspace", arguments: { workspaceId: "demo" } });
      assert.equal(opened.isError, undefined);

      const file = await client.callTool({ name: "read_file", arguments: { workspaceId: "demo", path: "readme.txt" } });
      assert.equal(file.isError, undefined);
      assert.equal(file.content[0]?.type, "text");
      assert.equal(file.content[0]?.text, "hello over MCP");

      const blocked = await client.callTool({ name: "read_file", arguments: { workspaceId: "demo", path: "../secret.txt" } });
      assert.equal(blocked.isError, true);

      const stateless = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: { workspaceId: "demo", path: "readme.txt" } },
        }),
      });
      assert.equal(stateless.status, 200);
      const statelessBody = await stateless.json() as { result?: { content?: Array<{ type?: string; text?: string }> } };
      assert.equal(statelessBody.result?.content?.[0]?.text, "hello over MCP");

      for (let index = 0; index < 40; index += 1) {
        const initialized = await fetch(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 10,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "stateless-regression", version: "0.1.0" },
            },
          }),
        });
        assert.equal(initialized.status, 200);
        assert.equal(initialized.headers.get("mcp-session-id"), null);
        await initialized.body?.cancel();
      }
    } finally {
      await client.close();
      await bridge.close();
      server.close();
      await once(server, "close");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
