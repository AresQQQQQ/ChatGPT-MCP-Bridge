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

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function toolByName(tools: readonly JsonObject[], name: string): JsonObject {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} is present`);
  return tool;
}

test("MCP tools expose usable exec union and consistent text/structured results", async () => {
  const fixtureRoot = await mkdtemp(path.join(process.cwd(), ".mcp-contract-"));
  const sourcePath = path.join(fixtureRoot, "example.ts");
  let bridge: Awaited<ReturnType<typeof createBridgeApp>> | undefined;
  let server: http.Server | undefined;
  let client: Client | undefined;

  try {
    await writeFile(sourcePath, "export const needle = 1;\n", "utf8");
    await writeFile(path.join(fixtureRoot, "notes.txt"), "needle appears in content\n", "utf8");
    await writeFile(path.join(fixtureRoot, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"));
    await writeFile(path.join(fixtureRoot, "broken.pdf"), "%PDF-1.7\nnot-a-real-pdf\n", "utf8");
    await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.stdout.write('contract-test-ok')\"" },
    }), "utf8");
    await writeFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "MCP Bridge Contract Test"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "bridge-contract@example.invalid"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["add", "--", "example.ts", "notes.txt", "package.json", "pnpm-lock.yaml"], { cwd: fixtureRoot, windowsHide: true });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixtureRoot, windowsHide: true });

    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      maxReadBytes: 1024 * 1024,
      workspaces: [{ id: "demo", root: fixtureRoot, mode: "workspace", allowedScripts: ["test"] }],
      configPath: path.join(fixtureRoot, "mcp-bridge.json"),
    };
    bridge = await createBridgeApp(config);
    server = http.createServer(bridge.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");

    client = new Client({ name: "mcp-contract-test", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));

    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => asObject(tool));
    const execTool = toolByName(tools, "exec_command");
    const execInputSchema = asObject(execTool.inputSchema);
    assert.equal(execInputSchema.type, "object");
    assert.deepEqual(asObject(execInputSchema.discriminator), { propertyName: "kind" });
    const execBranches = asArray(execInputSchema.oneOf).map(asObject);
    assert.equal(execBranches.length, 5);
    const branchKinds = execBranches.map((branch) => {
      const properties = asObject(branch.properties);
      return asObject(properties.kind).const;
    });
    assert.deepEqual(branchKinds, ["test", "build", "lint", "typecheck", "package-script"]);
    for (const branch of execBranches.slice(0, 4)) {
      const properties = asObject(branch.properties);
      assert.equal(asObject(properties.kind).const !== "package-script", true);
      assert.equal(asArray(branch.required).join(","), "workspaceId,kind");
      assert.equal("name" in properties, false);
      assert.equal("cwd" in properties, true);
      assert.equal(branch.additionalProperties, false);
    }
    const packageBranch = execBranches[4];
    assert.ok(packageBranch);
    const packageProperties = asObject(packageBranch.properties);
    assert.deepEqual(asArray(packageBranch.required), ["workspaceId", "kind", "name"]);
    assert.equal(asObject(packageProperties.name).type, "string");
    assert.equal("cwd" in packageProperties, true);
    assert.equal(packageBranch.additionalProperties, false);
    for (const branch of execBranches) assert.ok(asArray(branch.required).includes("workspaceId"));

    const readTool = toolByName(tools, "read_file");
    const readOutputSchema = asObject(readTool.outputSchema);
    assert.deepEqual(asArray(readOutputSchema.required), ["workspaceId", "path", "content", "bytes"]);
    const searchTool = toolByName(tools, "search");
    const searchOutputSchema = asObject(searchTool.outputSchema);
    assert.deepEqual(asArray(searchOutputSchema.required), ["workspaceId", "query", "results", "truncated"]);
    const extractPdfTextTool = toolByName(tools, "extract_pdf_text");
    const extractPdfTextInputSchema = asObject(extractPdfTextTool.inputSchema);
    assert.deepEqual(asArray(extractPdfTextInputSchema.required), ["workspaceId", "path"]);
    const extractPdfTextProperties = asObject(extractPdfTextInputSchema.properties);
    assert.equal(asObject(extractPdfTextProperties.startPage).type, "integer");
    assert.equal(asObject(extractPdfTextProperties.endPage).type, "integer");
    const extractPdfTextOutputSchema = asObject(extractPdfTextTool.outputSchema);
    assert.deepEqual(asArray(extractPdfTextOutputSchema.required), [
      "workspaceId", "path", "pageCount", "startPage", "endPage", "pages", "truncated",
    ]);
    const gitInitTool = toolByName(tools, "git_init");
    const gitInitInputSchema = asObject(gitInitTool.inputSchema);
    assert.deepEqual(asArray(gitInitInputSchema.required), ["workspaceId"]);
    assert.deepEqual(Object.keys(asObject(gitInitInputSchema.properties)), ["workspaceId"]);
    assert.equal(gitInitInputSchema.additionalProperties, false);
    const gitTool = toolByName(tools, "git_status");
    const gitOutputSchema = asObject(gitTool.outputSchema);
    assert.ok(asArray(gitOutputSchema.required).includes("stdout"));
    assert.ok(asArray(gitOutputSchema.required).includes("stderr"));
    for (const toolName of [
      "list_workspaces",
      "get_workspace_info",
      "get_image",
      "get_pdf_info",
      "extract_pdf_text",
      "render_pdf_page",
      "copy_file",
      "compare_tree",
      "compare_worktree_checkpoint",
      "copy_tree",
      "create_worktree_checkpoint",
      "find_processes",
      "inspect_process",
      "wait_process",
      "create_directory",
      "mkdir_p",
      "move_path",
      "delete_file",
      "delete_directory",
      "download_file",
      "list_recipes",
      "exec_recipe",
      "prepare_file_plan",
      "execute_file_plan",
      "read_files",
      "stat_files",
      "snapshot_tree",
      "find_files",
      "stat_file",
      "git_init",
      "git_add",
      "git_commit",
      "git_log",
      "git_show",
    ]) toolByName(tools, toolName);

    const createCheckpointTool = toolByName(tools, "create_worktree_checkpoint");
    const createCheckpointInputSchema = asObject(createCheckpointTool.inputSchema);
    assert.deepEqual(asArray(createCheckpointInputSchema.required), ["workspaceId"]);
    assert.match(String(createCheckpointTool.description ?? ""), /lost when the Bridge restarts/u);

    const compareCheckpointTool = toolByName(tools, "compare_worktree_checkpoint");
    const compareCheckpointInputSchema = asObject(compareCheckpointTool.inputSchema);
    assert.deepEqual(asArray(compareCheckpointInputSchema.required), ["workspaceId", "checkpointId"]);

    const inspectProcessTool = toolByName(tools, "inspect_process");
    const inspectProcessInputSchema = asObject(inspectProcessTool.inputSchema);
    assert.deepEqual(asArray(inspectProcessInputSchema.required), ["workspaceId", "pid"]);
    assert.equal(inspectProcessInputSchema.additionalProperties, false);
    assert.match(String(inspectProcessTool.description ?? ""), /no command line/u);

    const waitProcessTool = toolByName(tools, "wait_process");
    assert.match(String(waitProcessTool.description ?? ""), /maximum wait of 30 seconds/u);

    const snapshotTool = toolByName(tools, "snapshot_tree");
    const snapshotInputSchema = asObject(snapshotTool.inputSchema);
    assert.deepEqual(asArray(snapshotInputSchema.required), ["workspaceId"]);
    assert.equal(snapshotInputSchema.additionalProperties, false);
    assert.match(String(snapshotTool.description ?? ""), /expire after ten minutes/u);

    const compareTreeTool = toolByName(tools, "compare_tree");
    const compareTreeInputSchema = asObject(compareTreeTool.inputSchema);
    assert.deepEqual(asArray(compareTreeInputSchema.required), ["workspaceId", "leftSnapshotId", "rightSnapshotId"]);

    const preparePlanTool = toolByName(tools, "prepare_file_plan");
    const preparePlanInputSchema = asObject(preparePlanTool.inputSchema);
    assert.deepEqual(asArray(preparePlanInputSchema.required), ["workspaceId", "operations"]);
    assert.equal(preparePlanInputSchema.additionalProperties, false);
    assert.match(String(preparePlanTool.description ?? ""), /Batch delete is intentionally unsupported/u);

    const recipeTool = toolByName(tools, "exec_recipe");
    const recipeInputSchema = asObject(recipeTool.inputSchema);
    assert.deepEqual(asArray(recipeInputSchema.required), ["workspaceId", "recipeId"]);
    assert.deepEqual(Object.keys(asObject(recipeInputSchema.properties)), ["workspaceId", "recipeId"]);
    assert.equal(recipeInputSchema.additionalProperties, false);
    assert.match(String(recipeTool.description ?? ""), /Arbitrary shell input is not supported/u);

    const downloadTool = toolByName(tools, "download_file");
    const downloadInputSchema = asObject(downloadTool.inputSchema);
    assert.deepEqual(asArray(downloadInputSchema.required), ["workspaceId", "url", "targetPath"]);
    assert.match(String(downloadTool.description ?? ""), /local Bridge host/u);

    const workspaceList = await client.callTool({ name: "list_workspaces", arguments: {} });
    assert.equal(workspaceList.isError, undefined);
    const listedWorkspaces = asArray(asObject(workspaceList.structuredContent).workspaces).map(asObject);
    assert.equal(listedWorkspaces.length, 1);
    assert.equal(listedWorkspaces[0]?.workspaceId, "demo");
    assert.equal(listedWorkspaces[0]?.root, fixtureRoot);
    const workspaceInfo = await client.callTool({
      name: "get_workspace_info",
      arguments: { workspaceId: "demo" },
    });
    assert.equal(asObject(workspaceInfo.structuredContent).root, fixtureRoot);

    const validExec = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId: "demo", kind: "test" },
    });
    assert.equal(validExec.isError, undefined);
    assert.match(validExec.content[0]?.type === "text" ? validExec.content[0].text : "", /contract-test-ok/u);
    assert.match(String(asObject(validExec.structuredContent).stdout), /(?:^|\n)contract-test-ok(?:\n|$)/u);

    const invalidBuiltinName = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId: "demo", kind: "test", name: "test" },
    });
    const missingPackageName = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId: "demo", kind: "package-script" },
    });
    const missingWorkspaceId = await client.callTool({
      name: "exec_command",
      arguments: { kind: "test" },
    });
    for (const result of [invalidBuiltinName, missingPackageName, missingWorkspaceId]) {
      assert.equal(result.isError, true);
    }

    const read = await client.callTool({
      name: "read_file",
      arguments: { workspaceId: "demo", path: "example.ts" },
    });
    assert.equal(read.isError, undefined);
    assert.equal(read.content[0]?.type, "text");
    assert.equal(read.content[0]?.text, "export const needle = 1;\n");
    const readStructured = asObject(read.structuredContent);
    assert.equal(readStructured.content, "export const needle = 1;\n");
    assert.equal(readStructured.bytes, Buffer.byteLength("export const needle = 1;\n"));

    const image = await client.callTool({
      name: "get_image",
      arguments: { workspaceId: "demo", path: "pixel.png" },
    });
    assert.equal(image.isError, undefined);
    assert.equal(image.content[0]?.type, "image");
    if (image.content[0]?.type === "image") {
      assert.equal(image.content[0].mimeType, "image/png");
      assert.ok(image.content[0].data.length > 0);
    }
    const imageStructured = asObject(image.structuredContent);
    assert.equal(imageStructured.mimeType, "image/png");
    assert.equal(imageStructured.path, "pixel.png");

    const brokenPdfText = await client.callTool({
      name: "extract_pdf_text",
      arguments: { workspaceId: "demo", path: "broken.pdf", startPage: 1, endPage: 1 },
    });
    assert.equal(brokenPdfText.isError, true);
    const brokenPdfTextMessage = brokenPdfText.content[0]?.type === "text" ? brokenPdfText.content[0].text : "";
    assert.match(brokenPdfTextMessage, /^PDF text extractor failed:/u);
    assert.doesNotMatch(brokenPdfTextMessage, /^Request failed$/u);

    const brokenPdfRender = await client.callTool({
      name: "render_pdf_page",
      arguments: { workspaceId: "demo", path: "broken.pdf", page: 1 },
    });
    assert.equal(brokenPdfRender.isError, true);
    const brokenPdfRenderMessage = brokenPdfRender.content[0]?.type === "text" ? brokenPdfRender.content[0].text : "";
    assert.match(brokenPdfRenderMessage, /^PDF renderer failed:/u);
    assert.doesNotMatch(brokenPdfRenderMessage, /^Request failed$/u);

    const search = await client.callTool({
      name: "search",
      arguments: { workspaceId: "demo", query: "needle", path: ".", includeContent: true },
    });
    assert.equal(search.isError, undefined);
    const searchStructured = asObject(search.structuredContent);
    const searchResults = asArray(searchStructured.results).map(asObject);
    assert.ok(searchResults.some((result) => result.path === "notes.txt" && result.match === "content"));
    const contentMatch = searchResults.find((result) => result.path === "notes.txt");
    assert.equal(contentMatch?.line, 1);
    assert.equal(contentMatch?.preview, "needle appears in content");
    assert.equal(searchStructured.truncated, false);
    const searchText = search.content[0]?.type === "text" ? search.content[0].text : "";
    assert.deepEqual(JSON.parse(searchText), searchStructured);

    const statResult = await client.callTool({
      name: "stat_file",
      arguments: { workspaceId: "demo", path: "example.ts", includeHash: true },
    });
    assert.equal(statResult.isError, undefined);
    const statStructured = asObject(statResult.structuredContent);
    assert.equal(statStructured.kind, "file");
    assert.equal(typeof statStructured.mtimeMs, "number");
    assert.match(String(statStructured.contentHash), /^[a-f0-9]{64}$/u);

    const findResult = await client.callTool({
      name: "find_files",
      arguments: { workspaceId: "demo", pattern: "**/*.ts" },
    });
    assert.equal(findResult.isError, undefined);
    const findStructured = asObject(findResult.structuredContent);
    assert.ok(asArray(findStructured.results).map(asObject).some((result) => result.path === "example.ts"));
    assert.equal(findStructured.truncated, false);

    await client.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: "demo",
        path: "example.ts",
        patch: { hunks: [{ oldText: "needle = 1", newText: "needle = 42" }] },
      },
    });
    assert.equal(await readFile(sourcePath, "utf8"), "export const needle = 42;\n");

    const status = await client.callTool({ name: "git_status", arguments: { workspaceId: "demo" } });
    assert.equal(status.isError, undefined);
    const statusStructured = asObject(status.structuredContent);
    assert.equal(typeof statusStructured.stdout, "string");
    assert.equal(typeof statusStructured.stderr, "string");
    assert.match(String(statusStructured.stdout), /example\.ts/u);
    assert.match(status.content[0]?.type === "text" ? status.content[0].text : "", /stdout:/u);

    const diff = await client.callTool({
      name: "git_diff",
      arguments: { workspaceId: "demo", path: "example.ts" },
    });
    assert.equal(diff.isError, undefined);
    const diffStructured = asObject(diff.structuredContent);
    assert.match(String(diffStructured.stdout), /\+export const needle = 42;/u);
    assert.equal(typeof diffStructured.stderr, "string");
    assert.match(diff.content[0]?.type === "text" ? diff.content[0].text : "", /stdout:/u);
    assert.match(diff.content[0]?.type === "text" ? diff.content[0].text : "", /\+export const needle = 42;/u);

    const gitAddResult = await client.callTool({
      name: "git_add",
      arguments: { workspaceId: "demo", paths: ["example.ts"] },
    });
    assert.equal(gitAddResult.isError, undefined);
    const gitCommitResult = await client.callTool({
      name: "git_commit",
      arguments: { workspaceId: "demo", message: "update example" },
    });
    assert.equal(gitCommitResult.isError, undefined);

    const log = await client.callTool({
      name: "git_log",
      arguments: { workspaceId: "demo", maxCount: 1 },
    });
    assert.equal(log.isError, undefined);
    assert.match(String(asObject(log.structuredContent).stdout), /update example/u);

    const show = await client.callTool({
      name: "git_show",
      arguments: { workspaceId: "demo", commitish: "HEAD", path: "example.ts" },
    });
    assert.equal(show.isError, undefined);
    assert.match(String(asObject(show.structuredContent).stdout), /export const needle = 42/u);

    assert.equal((await client.callTool({
      name: "create_directory",
      arguments: { workspaceId: "demo", path: "generated" },
    })).isError, undefined);
    assert.equal((await client.callTool({
      name: "write_file",
      arguments: { workspaceId: "demo", path: "generated/old.ts", content: "export {};\n" },
    })).isError, undefined);
    assert.equal((await client.callTool({
      name: "copy_file",
      arguments: { workspaceId: "demo", sourcePath: "generated/old.ts", targetPath: "generated/copy.ts" },
    })).isError, undefined);
    assert.equal(await readFile(path.join(fixtureRoot, "generated", "copy.ts"), "utf8"), "export {};\n");
    assert.equal((await client.callTool({
      name: "move_path",
      arguments: { workspaceId: "demo", sourcePath: "generated/old.ts", targetPath: "generated/new.ts" },
    })).isError, undefined);
    assert.equal((await client.callTool({
      name: "delete_file",
      arguments: { workspaceId: "demo", path: "generated/new.ts" },
    })).isError, undefined);
    assert.equal((await client.callTool({
      name: "delete_file",
      arguments: { workspaceId: "demo", path: "generated/copy.ts" },
    })).isError, undefined);
    assert.equal((await client.callTool({
      name: "delete_directory",
      arguments: { workspaceId: "demo", path: "generated" },
    })).isError, undefined);

    const unknown = await client.callTool({
      name: "read_file",
      arguments: { workspaceId: "missing", path: "example.ts" },
    });
    assert.equal(unknown.isError, true);
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
