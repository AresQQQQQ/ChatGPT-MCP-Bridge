import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

test("config loader resolves relative workspace roots from the config directory", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "demo", root: "workspace", mode: "readonly" }] }), "utf8");

  const config = await loadConfig(configPath);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.workspaces[0]?.root, path.join(tempRoot, "workspace"));
  assert.equal(config.workspaces[0]?.mode, "readonly");
});

test("config loader resolves a local tunnel client and applies its loopback health default", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-tunnel-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    tunnel: { clientPath: "bin/tunnel-client.exe", profile: "web-test" },
    workspaces: [{ id: "demo", root: "." }],
  }), "utf8");

  const config = await loadConfig(configPath);
  assert.deepEqual(config.tunnel, {
    clientPath: path.join(tempRoot, "bin", "tunnel-client.exe"),
    profile: "web-test",
    healthUrl: "http://127.0.0.1:8080",
  });
});

test("config loader resolves Codex runtime/state paths and workspace module bindings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-codex-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    codex: { clientPath: "bin/codex.exe" },
    workspaces: [{
      id: "demo",
      root: ".",
      mode: "workspace",
      codex: { enabled: true, modules: { media: "Media / PDF" } },
    }],
  }), "utf8");

  const config = await loadConfig(configPath);
  assert.deepEqual(config.codex, {
    clientPath: path.join(tempRoot, "bin", "codex.exe"),
    stateFile: path.join(tempRoot, ".mcp-bridge-state", "codex.json"),
  });
  assert.deepEqual(config.workspaces[0]?.codex, {
    enabled: true,
    modules: { media: "Media / PDF" },
  });
});

test("config loader accepts workspace-local loopback MCP servers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-local-mcp-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    workspaces: [{
      id: "demo",
      root: ".",
      mcpServers: { creo: { url: "http://127.0.0.1:3011/mcp" } },
    }],
  }), "utf8");

  const config = await loadConfig(configPath);
  assert.deepEqual(config.workspaces[0]?.mcpServers, {
    creo: { url: "http://127.0.0.1:3011/mcp" },
  });
});

test("config loader rejects non-loopback workspace MCP servers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-local-mcp-public-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    workspaces: [{
      id: "demo",
      root: ".",
      mcpServers: { bad: { url: "https://example.com/mcp" } },
    }],
  }), "utf8");

  await assert.rejects(loadConfig(configPath), /workspaces\.0\.mcpServers\.bad\.url must use a loopback http URL/u);
});

test("config loader accepts Controlled Recipes with fixed argv", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-recipe-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    workspaces: [{
      id: "demo",
      root: ".",
      recipes: {
        unit: {
          description: "Run unit tests",
          executable: process.execPath,
          args: ["-e", "process.stdout.write('recipe-ok')"],
          cwd: ".",
          timeoutMs: 12_345,
        },
      },
    }],
  }), "utf8");

  const config = await loadConfig(configPath);
  assert.deepEqual(config.workspaces[0]?.recipes, {
    unit: {
      description: "Run unit tests",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('recipe-ok')"],
      cwd: ".",
      timeoutMs: 12_345,
    },
  });
});

test("config loader rejects invalid Controlled Recipe ids, cwd, and executable forms", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-recipe-invalid-"));
  const configPath = path.join(tempRoot, "bridge.json");
  for (const recipes of [
    { "bad id": { executable: "python", args: [] } },
    { badcwd: { executable: "python", args: [], cwd: "../outside" } },
    { badexe: { executable: "tools/python.exe", args: [] } },
  ]) {
    await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "demo", root: ".", recipes }] }), "utf8");
    await assert.rejects(loadConfig(configPath), /Invalid config/u);
  }
});

test("config loader accepts trusted-dev workspace mode", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-config-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    workspaces: [{ id: "demo", root: ".", mode: "trusted-dev" }],
  }), "utf8");

  const config = await loadConfig(configPath);
  assert.equal(config.workspaces[0]?.mode, "trusted-dev");
});

test("config loader rejects non-loopback tunnel health URLs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-tunnel-public-"));
  const configPath = path.join(tempRoot, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    tunnel: { clientPath: "tunnel-client", profile: "web-test", healthUrl: "https://example.com" },
    workspaces: [{ id: "demo", root: "." }],
  }), "utf8");

  await assert.rejects(loadConfig(configPath), /tunnel\.healthUrl must use a loopback http URL/);
});
