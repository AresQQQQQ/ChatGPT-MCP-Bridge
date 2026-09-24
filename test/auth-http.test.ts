import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAuthToken, type BridgeConfig } from "../src/config.js";
import { createBridgeApp } from "../src/http/server.js";

async function makeConfig(host: string, token?: string): Promise<{ config: BridgeConfig; root: string }> {
  const root = await mkdtemp(path.join(process.cwd(), ".mcp-bridge-auth-"));
  await writeFile(path.join(root, "hello.txt"), "authenticated", "utf8");
  return { root, config: {
    host,
    port: 3000,
    mcpPath: "/mcp",
    maxReadBytes: 1024,
    ...(token ? { auth: { token } } : {}),
    allowedOrigins: ["http://allowed.example"],
    workspaces: [{ id: "demo", root }],
    configPath: path.join(root, "bridge.json"),
  } };
}

async function start(config: BridgeConfig) {
  const bridge = await createBridgeApp(config);
  const server = http.createServer(bridge.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose an address");
  return { bridge, server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

function postWithHost(url: URL, host: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        Host: host,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

test("non-loopback servers fail closed without a strong auth token", async () => {
  const temp = await makeConfig("0.0.0.0");
  try {
    await assert.rejects(createBridgeApp(temp.config), /requires a configured auth token/);
  } finally {
    await rm(temp.root, { recursive: true, force: true });
  }
});

test("MCP HTTP enforces exact Host/Origin and Bearer authentication", async () => {
  const token = createAuthToken();
  const temp = await makeConfig("127.0.0.1", token);
  const { bridge, server, url } = await start(temp.config);
  const baseUrl = new URL(url);
  try {
    const missing = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, "Unauthorized");

    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: "{}",
    });
    assert.equal(invalid.status, 401);

    const badOrigin = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: "http://attacker.example",
      },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);

    const badHost = await postWithHost(url, "attacker.example", token);
    assert.equal(badHost.status, 400);
    assert.deepEqual(JSON.parse(badHost.body), { error: "Invalid Host" });

    const malformed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{bad",
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get("content-type") ?? "", /application\/json/u);
    assert.deepEqual(await malformed.json(), { error: "Invalid request body" });

    const client = new Client({ name: "auth-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://allowed.example",
        },
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 55);
      assert.ok(tools.tools.every((tool) => tool.outputSchema !== undefined));
      const applyPatch = tools.tools.find((tool) => tool.name === "apply_patch");
      assert.equal(applyPatch?.annotations?.destructiveHint, true);
    } finally {
      await client.close();
    }

    const health = await fetch(new URL("/health", baseUrl));
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "chatgpt-mcp-bridge",
      capabilities: {
        bridgeCapabilityVersion: 7,
        codexStateVersion: 4,
        codexModuleModel: "configured-temporary-single-binding",
        codexExecutionTransport: "desktop-ipc",
        codexDefaultModel: "gpt-5.6-luna",
        codexDefaultReasoningEffort: "max",
      },
    });
  } finally {
    await bridge.close();
    server.close();
    await once(server, "close");
    await rm(temp.root, { recursive: true, force: true });
  }
});
