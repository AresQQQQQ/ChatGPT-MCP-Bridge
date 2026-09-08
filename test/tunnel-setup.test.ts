import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { configFileTemplate, loadConfig } from "../src/config.js";
import { buildTunnelSpawnSpec } from "../src/tunnel.js";
import { readBounded, selectAsset, setupTunnel, updateRuntimeKey, verifyArchive } from "../src/setup/tunnel-setup.js";

const data = Buffer.from("test archive");
const asset = { name: "tunnel-client-v1.0.0-windows-amd64.zip", size: data.length,
  digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
  browser_download_url: "https://github.com/openai/tunnel-client/releases/download/v1.0.0/client.zip" };

test("installer selects the exact official architecture and requires a digest", () => {
  const release = { tag_name: "v1.0.0", assets: [asset, { ...asset, name: "tunnel-client-v1.0.0-windows-arm64.zip" }] };
  assert.equal(selectAsset(release, "x64"), asset);
  assert.match(selectAsset(release, "arm64").name, /arm64/);
  assert.throws(() => selectAsset(release, "ia32"));
  assert.throws(() => selectAsset({ ...release, assets: [{ ...asset, digest: "" }] }, "x64"));
  assert.throws(() => selectAsset({ ...release, assets: [{ ...asset, browser_download_url: "https://example.com/client.zip" }] }, "x64"));
  verifyArchive(data, asset);
  assert.throws(() => verifyArchive(Buffer.from("changed data"), asset), /校验失败/);
});

test("installer rejects oversized and failed HTTP responses", async () => {
  assert.deepEqual(await readBounded(new Response(data), data.length), data);
  await assert.rejects(readBounded(new Response(data), 2), /大小限制/);
  await assert.rejects(readBounded(new Response("error", { status: 403 }), 20), /403/);
});

test("runtime key replacement retains parsed env values and removes duplicate assignments", () => {
  const env = 'OTHER="first\nsecond"\nCONTROL_PLANE_API_KEY=old\nCONTROL_PLANE_API_KEY=shadow\n';
  const changed = updateRuntimeKey(env, "new-test-key");
  assert.deepEqual(parseEnv(changed), { OTHER: "first\nsecond", CONTROL_PLANE_API_KEY: "new-test-key" });
  assert.equal((changed.match(/CONTROL_PLANE_API_KEY=/g) ?? []).length, 1);
  assert.throws(() => updateRuntimeKey(env, "invalid\nKEY=value"));
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "mcp-bridge.json");
  const client = path.join(root, "existing.exe");
  await writeFile(client, "fixture");
  const config = { ...JSON.parse(configFileTemplate()), customSetting: { keep: true },
    tunnel: { clientPath: client, profile: "original", healthUrl: "http://127.0.0.1:8080" } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=old-test-key\nOTHER=keep\n");
  return { root, configPath, config, client,
    input: { configPath, tunnelId: "tunnel_fixture", runtimeKey: "new-test-key", healthPort: 8081, reuseClient: true } };
}

test("setup preserves workspaces and auth, isolates profiles, and keeps keys out of argv/logs", async t => {
  const f = await fixture(t);
  const logs: string[] = [];
  let args: string[] = [];
  await setupTunnel(f.input, {
    initialize: async (client, argv) => { assert.equal(client, f.client); args = argv; },
    progress: message => logs.push(message), install: async () => { throw Error("must reuse"); },
  });
  const raw = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(raw.workspaces, f.config.workspaces);
  assert.deepEqual(raw.auth, f.config.auth);
  assert.deepEqual(raw.customSetting, { keep: true });
  assert.equal(raw.tunnel.profile, "bridge");
  assert.ok(raw.tunnel.profileDir.startsWith(path.join(f.root, ".mcp-bridge-state")));
  assert.ok(args.includes(raw.tunnel.profileDir));
  assert.doesNotMatch(args.join(" ") + logs.join(" "), /new-test-key|old-test-key/);
  assert.deepEqual(parseEnv(await readFile(path.join(f.root, ".env"), "utf8")), { CONTROL_PLANE_API_KEY: "new-test-key", OTHER: "keep" });
  const loaded = await loadConfig(f.configPath);
  assert.ok(loaded.tunnel);
  assert.deepEqual(buildTunnelSpawnSpec(loaded.tunnel, loaded.auth).args,
    ["run", "--profile", "bridge", "--profile-dir", raw.tunnel.profileDir]);
});

test("initialization failure leaves existing config and env byte-identical and cleans staging", async t => {
  const f = await fixture(t);
  const beforeConfig = await readFile(f.configPath);
  const beforeEnv = await readFile(path.join(f.root, ".env"));
  await assert.rejects(setupTunnel(f.input, { initialize: async () => { throw Error("init failed"); } }), /init failed/);
  assert.deepEqual(await readFile(f.configPath), beforeConfig);
  assert.deepEqual(await readFile(path.join(f.root, ".env")), beforeEnv);
  assert.deepEqual(await readdir(path.join(f.root, ".mcp-bridge-state")), []);
});

test("fresh setup generates config while download failure never creates config or env", async t => {
  const f = await fixture(t);
  await rm(f.configPath); await rm(path.join(f.root, ".env"));
  const input = { ...f.input, reuseClient: false };
  await assert.rejects(setupTunnel(input, { install: async () => { throw Error("hash mismatch"); } }), /hash mismatch/);
  await assert.rejects(readFile(f.configPath), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, ".env")), { code: "ENOENT" });
  await setupTunnel(input, { install: async () => f.client, initialize: async () => {} });
  const config = await loadConfig(f.configPath);
  assert.equal(config.workspaces[0]?.id, "default");
  assert.ok(config.auth?.token);
});

test("blank key reuses local key and rejects a concurrent config edit", async t => {
  const f = await fixture(t);
  await setupTunnel({ ...f.input, runtimeKey: "" }, { initialize: async () => {} });
  assert.equal(parseEnv(await readFile(path.join(f.root, ".env"), "utf8")).CONTROL_PLANE_API_KEY, "old-test-key");
  const newConfig = JSON.stringify({ ...f.config, changedElsewhere: true });
  await assert.rejects(setupTunnel(f.input, { initialize: async () => { await writeFile(f.configPath, newConfig); } }), /被修改/);
  assert.equal(await readFile(f.configPath, "utf8"), newConfig);
  assert.equal(parseEnv(await readFile(path.join(f.root, ".env"), "utf8")).CONTROL_PLANE_API_KEY, "old-test-key");
});

test("invalid tunnel ID, key and colliding port fail before invoking installer", async t => {
  const f = await fixture(t);
  const deps = { install: async (): Promise<string> => { assert.fail("must not download"); } };
  await assert.rejects(setupTunnel({ ...f.input, tunnelId: "bad id" }, deps));
  await assert.rejects(setupTunnel({ ...f.input, runtimeKey: "bad\nkey" }, deps));
  await assert.rejects(setupTunnel({ ...f.input, healthPort: 3000 }, deps), /不能与 Bridge/);
});
