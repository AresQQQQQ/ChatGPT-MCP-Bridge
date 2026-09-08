import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeRuntime } from "../src/commands/index.js";
import { loadConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";

async function captureLogs(callback: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { code: await callback(), output: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("init writes a protected config and shows the generated token once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-cli-"));
  const configPath = path.join(root, "bridge.json");
  const captured = await captureLogs(() => runCli(["init", "--config", configPath]));
  assert.equal(captured.code, 0);

  const config = await loadConfig(configPath);
  const token = config.auth?.token;
  assert.ok(token);
  assert.equal(captured.output.split(token).length - 1, 1);
  assert.match(captured.output, /Generated auth token \(shown once/);

  const mode = (await stat(configPath)).mode & 0o777;
  if (process.platform !== "win32") {
    assert.equal(mode, 0o600);
  }
});

test("doctor checks runtime, Git, roots, and auth/listening policy without printing the token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-doctor-"));
  const configPath = path.join(root, "bridge.json");
  await writeFile(
    configPath,
    JSON.stringify({ host: "127.0.0.1", port: 3000, auth: { token: "".padStart(43, "a") }, workspaces: [{ id: "demo", root: "." }] }),
    "utf8",
  );

  const captured = await captureLogs(() => runCli(["doctor", "--config", configPath]));
  assert.equal(captured.code, 0);
  assert.match(captured.output, /OK Node\.js: FOUND/);
  assert.match(captured.output, /OK Git: FOUND/);
  assert.match(captured.output, /OK npm: NOT REQUIRED/);
  assert.match(captured.output, /OK pnpm: NOT REQUIRED/);
  assert.match(captured.output, /OK yarn: NOT REQUIRED/);
  assert.match(captured.output, /OK bun: NOT REQUIRED/);
  assert.match(captured.output, /OK config:/);
  assert.match(captured.output, /OK root 'demo': policy and permissions valid/);
  assert.match(captured.output, /OK auth\/listening policy:/);
  assert.doesNotMatch(captured.output, /aaaa/);
});

test("doctor rejects a public binding without authentication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-doctor-public-"));
  const configPath = path.join(root, "bridge.json");
  await writeFile(
    configPath,
    JSON.stringify({ host: "0.0.0.0", port: 3000, workspaces: [{ id: "demo", root: "." }] }),
    "utf8",
  );

  const captured = await captureLogs(() => runCli(["doctor", "--config", configPath]));
  assert.equal(captured.code, 1);
  assert.match(captured.output, /FAIL auth\/listening policy: Non-loopback host requires/);
});

test("doctor marks a workspace package manager as required", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-doctor-manager-"));
  const configPath = path.join(root, "bridge.json");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "node -e \"\"" } }), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({ host: "127.0.0.1", port: 3000, auth: { token: "".padStart(43, "a") }, workspaces: [{ id: "demo", root: "." }] }),
    "utf8",
  );

  const probe = await probeRuntime("pnpm");
  const captured = await captureLogs(() => runCli(["doctor", "--config", configPath]));
  assert.match(captured.output, /(?:OK|FAIL) pnpm: (?:FOUND|NOT FOUND) \(required by demo\)/);
  if (probe.status === "FOUND") {
    assert.equal(captured.code, 0);
    assert.match(captured.output, /OK pnpm: FOUND \(required by demo\)/);
  } else {
    assert.equal(captured.code, 1);
    assert.match(captured.output, /FAIL pnpm: NOT FOUND \(required by demo\)/);
  }
});

test("start requires the project-local .env file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-start-env-missing-"));
  const configPath = path.join(root, "bridge.json");
  await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "demo", root: "." }] }), "utf8");

  await assert.rejects(runCli(["start", "--config", configPath]), /Missing .*\.env/);
});

test("start gives project .env values precedence over inherited values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-start-env-local-"));
  const configPath = path.join(root, "bridge.json");
  await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "demo", root: "." }] }), "utf8");
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=project-local-key\n", "utf8");
  const previous = process.env.CONTROL_PLANE_API_KEY;
  process.env.CONTROL_PLANE_API_KEY = "inherited-key";
  try {
    await assert.rejects(runCli(["start", "--config", configPath]), /must define tunnel\.clientPath and tunnel\.profile/);
    assert.equal(process.env.CONTROL_PLANE_API_KEY, "project-local-key");
  } finally {
    if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY;
    else process.env.CONTROL_PLANE_API_KEY = previous;
  }
});
