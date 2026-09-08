import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";
import { LocalMcpRegistry } from "../src/mcp/local-mcp-registry.js";

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
  return address.port;
}

test("local MCP loaded state persists across registry restarts and ignores stale state entries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-registry-state-"));
  const stateFile = path.join(tempRoot, ".mcp-bridge-state", "local-mcp.json");
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    maxReadBytes: 1024,
    workspaces: [{
      id: "demo",
      root: tempRoot,
      mcpServers: { local: { url: "http://127.0.0.1:3011/mcp" } },
    }],
    configPath: path.join(tempRoot, "mcp-bridge.json"),
  };

  try {
    const first = new LocalMcpRegistry(config, stateFile);
    await first.initialize();
    assert.equal(first.list()[0]?.loaded, true);
    await first.unload("demo", "local");
    assert.equal(first.list()[0]?.loaded, false);
    const persistedAfterUnload = JSON.parse(await readFile(stateFile, "utf8")) as { servers?: Array<Record<string, unknown>> };
    assert.equal(persistedAfterUnload.servers?.[0]?.loaded, false);

    const second = new LocalMcpRegistry(config, stateFile);
    await second.initialize();
    assert.equal(second.list()[0]?.loaded, false, "restart restores unloaded state");
    await second.load("demo", "local");

    const third = new LocalMcpRegistry(config, stateFile);
    await third.initialize();
    assert.equal(third.list()[0]?.loaded, true, "restart restores loaded state");

    await writeFile(stateFile, JSON.stringify({
      version: 1,
      servers: [
        { workspaceId: "demo", serverId: "local", loaded: false },
        { workspaceId: "demo", serverId: "removed", loaded: true },
      ],
    }), "utf8");
    const staleState = new LocalMcpRegistry(config, stateFile);
    await staleState.initialize();
    assert.deepEqual(staleState.list().map(({ serverId, loaded }) => ({ serverId, loaded })), [
      { serverId: "local", loaded: false },
    ]);

    await writeFile(stateFile, "{broken-json", "utf8");
    const invalidState = new LocalMcpRegistry(config, stateFile);
    await invalidState.initialize();
    assert.equal(invalidState.list()[0]?.loaded, true, "invalid state falls back to configured default");
    assert.match(invalidState.consumeStateWarning() ?? "", /invalid/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("configured local MCP proxy lists and calls loopback tools", async () => {
  const downstreamApp = express();
  downstreamApp.use(express.json({ limit: "1mb" }));
  downstreamApp.all("/mcp", async (request, response) => {
    const server = new McpServer({ name: "downstream-test", version: "0.1.0" });
    server.registerTool("echo_value", {
      description: "Echo one test value",
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ echoed: z.string() }),
    }, async ({ value }) => ({
      content: [{ type: "text" as const, text: value }],
      structuredContent: { echoed: value },
    }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close();
    }
  });
  const downstreamHttp = http.createServer(downstreamApp);
  const downstreamPort = await listen(downstreamHttp);

  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    maxReadBytes: 1024 * 1024,
    workspaces: [{
      id: "demo",
      root: process.cwd(),
      mode: "readonly",
      mcpServers: { local: { url: `http://127.0.0.1:${downstreamPort}/mcp` } },
    }],
    configPath: `${process.cwd()}/mcp-bridge.json`,
  };

  const bridge = await createBridgeApp(config);
  const bridgeHttp = http.createServer(bridge.app);
  const bridgePort = await listen(bridgeHttp);
  const client = new Client({ name: "proxy-e2e", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridgePort}/mcp`));

  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.callTool({
      name: "mcp_list_tools",
      arguments: { workspaceId: "demo", serverId: "local" },
    });
    assert.equal(listed.isError, undefined);
    const listedContent = listed.structuredContent as { tools?: Array<{ name?: string }> } | undefined;
    assert.equal(listedContent?.tools?.some((tool) => tool.name === "echo_value"), true);

    const called = await client.callTool({
      name: "mcp_call_tool",
      arguments: {
        workspaceId: "demo",
        serverId: "local",
        toolName: "echo_value",
        arguments: { value: "proxy-ok" },
      },
    });
    assert.equal(called.isError, undefined);
    const calledContent = called.structuredContent as {
      downstreamIsError?: boolean;
      structuredContent?: { echoed?: string };
    } | undefined;
    assert.equal(calledContent?.downstreamIsError, false);
    assert.equal(calledContent?.structuredContent?.echoed, "proxy-ok");

    const initialServers = await client.callTool({
      name: "mcp_server_list",
      arguments: { workspaceId: "demo" },
    });
    assert.equal(initialServers.isError, undefined);
    const initialServerContent = initialServers.structuredContent as {
      servers?: Array<{ serverId?: string; loaded?: boolean }>;
    } | undefined;
    assert.deepEqual(initialServerContent?.servers, [{
      workspaceId: "demo",
      serverId: "local",
      url: `http://127.0.0.1:${downstreamPort}/mcp`,
      loaded: true,
    }]);

    const unloaded = await client.callTool({
      name: "mcp_server_unload",
      arguments: { workspaceId: "demo", serverId: "local" },
    });
    assert.equal(unloaded.isError, undefined);
    assert.equal((unloaded.structuredContent as { loaded?: boolean } | undefined)?.loaded, false);

    const listedWhileUnloaded = await client.callTool({
      name: "mcp_list_tools",
      arguments: { workspaceId: "demo", serverId: "local" },
    });
    assert.equal(listedWhileUnloaded.isError, true);
    assert.match(listedWhileUnloaded.content[0]?.type === "text" ? listedWhileUnloaded.content[0].text : "", /unloaded/u);

    const calledWhileUnloaded = await client.callTool({
      name: "mcp_call_tool",
      arguments: {
        workspaceId: "demo",
        serverId: "local",
        toolName: "echo_value",
        arguments: { value: "must-not-call" },
      },
    });
    assert.equal(calledWhileUnloaded.isError, true);

    const probed = await client.callTool({
      name: "mcp_server_probe",
      arguments: { workspaceId: "demo", serverId: "local" },
    });
    assert.equal(probed.isError, undefined);
    const probedContent = probed.structuredContent as {
      loaded?: boolean;
      reachable?: boolean;
      toolCount?: number;
    } | undefined;
    assert.equal(probedContent?.loaded, false);
    assert.equal(probedContent?.reachable, true);
    assert.equal(probedContent?.toolCount, 1);

    const afterProbe = await client.callTool({
      name: "mcp_server_list",
      arguments: { workspaceId: "demo" },
    });
    const afterProbeContent = afterProbe.structuredContent as {
      servers?: Array<{ loaded?: boolean }>;
    } | undefined;
    assert.equal(afterProbeContent?.servers?.[0]?.loaded, false);

    const loaded = await client.callTool({
      name: "mcp_server_load",
      arguments: { workspaceId: "demo", serverId: "local" },
    });
    assert.equal(loaded.isError, undefined);
    assert.equal((loaded.structuredContent as { loaded?: boolean } | undefined)?.loaded, true);

    const calledAfterLoad = await client.callTool({
      name: "mcp_call_tool",
      arguments: {
        workspaceId: "demo",
        serverId: "local",
        toolName: "echo_value",
        arguments: { value: "hot-load-ok" },
      },
    });
    assert.equal(calledAfterLoad.isError, undefined);
    const calledAfterLoadContent = calledAfterLoad.structuredContent as {
      structuredContent?: { echoed?: string };
    } | undefined;
    assert.equal(calledAfterLoadContent?.structuredContent?.echoed, "hot-load-ok");
  } finally {
    await client.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    bridgeHttp.close();
    downstreamHttp.close();
    await Promise.all([
      once(bridgeHttp, "close").catch(() => undefined),
      once(downstreamHttp, "close").catch(() => undefined),
    ]);
  }
});
