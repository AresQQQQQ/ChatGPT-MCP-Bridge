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
  assert.deepEqual({ ...parseEnv(changed) }, { OTHER: "first\nsecond", CONTROL_PLANE_API_KEY: "new-test-key" });
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
  assert.deepEqual({ ...parseEnv(await readFile(path.join(f.root, ".env"), "utf8")) }, { CONTROL_PLANE_API_KEY: "new-test-key", OTHER: "keep" });
  const loaded = await loadConfig(f.configPath);
  assert.ok(loaded.tunnel);
  assert.deepEqual(buildTunnelSpawnSpec(loaded.tunnel, loaded.auth).args,
    ["run", "--profile", "bridge", "--profile-dir", raw.tunnel.profileDir]);
});

test("setup persists a selected Bridge port and initializes Tunnel with the matching MCP URL", async t => {
  const f = await fixture(t);
  const bridgePort = 3217;
  let args: string[] = [];
  await setupTunnel({ ...f.input, bridgePort }, {
    initialize: async (_client, argv) => { args = argv; },
  });
  const raw = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.equal(raw.port, bridgePort);
  const urlIndex = args.indexOf("--mcp-server-url");
  assert.ok(urlIndex >= 0);
  assert.equal(args[urlIndex + 1], `http://127.0.0.1:${bridgePort}/mcp`);
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

test("setup rejects an invalid or colliding selected Bridge port before installation", async t => {
  const f = await fixture(t);
  const deps = { install: async (): Promise<string> => { assert.fail("must not download"); } };
  await assert.rejects(setupTunnel({ ...f.input, bridgePort: 0 }, deps), /Bridge/);
  await assert.rejects(setupTunnel({ ...f.input, bridgePort: 65536 }, deps), /Bridge/);
  await assert.rejects(setupTunnel({ ...f.input, bridgePort: 8081 }, deps), /不能与 Bridge/);
});
test("installer selects darwin arm64 explicitly without changing Windows assets", () => {
  const mac = { ...asset, name: "tunnel-client-v1.0.0-darwin-arm64.zip" };
  const release = { tag_name: "v1.0.0", assets: [asset, mac] };
  assert.equal(selectAsset(release, "arm64", "darwin"), mac);
  assert.equal(selectAsset(release, "x64", "win32"), asset);
  assert.throws(() => selectAsset(release, "x64", "darwin"));
  assert.throws(() => selectAsset(release, "arm64", "linux"));
  assert.throws(() => selectAsset({ ...release, assets: [{ ...mac, digest: "" }] }, "arm64", "darwin"));
});

test("macOS ZIP requires unique exact runtime entries and ignores archive-controlled paths", async () => {
  const installer = await import("../src/setup/tunnel-setup.js");
  assert.equal(typeof installer.validateDarwinEntries, "function");
  const names = ["tunnel-client", "cloudflared", "cloudflared-manifest.json"];
  assert.doesNotThrow(() => installer.validateDarwinEntries([...names, "../../outside", "LICENSE"].join("\n")));
  assert.throws(() => installer.validateDarwinEntries([...names, "tunnel-client"].join("\n")));
  assert.throws(() => installer.validateDarwinEntries(names.slice(1).join("\n")));
  assert.throws(() => installer.validateDarwinEntries(names.map(n => `nested/${n}`).join("\n")));
});

test("macOS extraction writes only fixed regular files with executable permissions", { skip: process.platform !== "darwin" }, async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, stat } = await import("node:fs/promises");
  const installer = await import("../src/setup/tunnel-setup.js");
  assert.equal(typeof installer.extractDarwinArchive, "function");
  const f = await fixture(t);
  const source = path.join(f.root, "zip-source");
  const destination = path.join(f.root, "installed");
  await mkdir(source); await mkdir(destination);
  for (const name of ["tunnel-client", "cloudflared", "cloudflared-manifest.json", "unexpected"]) {
    await writeFile(path.join(source, name), name);
  }
  const archive = path.join(f.root, "client.zip");
  await promisify(execFile)("/usr/bin/zip", ["-q", archive, "tunnel-client", "cloudflared", "cloudflared-manifest.json", "unexpected"], { cwd: source });
  await installer.extractDarwinArchive(archive, destination);
  assert.deepEqual((await readdir(destination)).sort(), ["cloudflared", "cloudflared-manifest.json", "tunnel-client"]);
  for (const name of ["tunnel-client", "cloudflared"]) {
    const info = await stat(path.join(destination, name));
    assert.ok(info.isFile()); assert.equal(info.mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(destination, name), "utf8"), name);
  }
  await assert.rejects(installer.extractDarwinArchive(archive, destination), /解压/);
  const bounded = path.join(f.root, "bounded");
  await mkdir(bounded);
  await writeFile(path.join(source, "cloudflared-manifest.json"), "x".repeat(64 * 1024 + 1));
  await promisify(execFile)("/usr/bin/zip", ["-q", archive, "cloudflared-manifest.json"], { cwd: source });
  await assert.rejects(installer.extractDarwinArchive(archive, bounded), /解压/);
  await assert.rejects(readFile(path.join(bounded, "cloudflared-manifest.json")), { code: "ENOENT" });

});
