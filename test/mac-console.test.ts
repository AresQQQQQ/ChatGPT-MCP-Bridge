import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const module = await import("../src/ui/mac-console.js").catch(() => ({ launchMacControlUi: undefined }));
  assert.equal(typeof module.launchMacControlUi, "function", "Mac control host is implemented");
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-mac-ui-"));
  const configPath = path.join(root, "mcp-bridge.json");
  await writeFile(configPath, JSON.stringify({ auth: { token: "local-private-token" }, workspaces: [{ id: "mac", root, mode: "trusted-dev", allowedScripts: ["test"] }] }));
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=runtime-private-key\n");
  let state = "stopped", starts = 0, stops = 0;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let logs = [{ timestamp: "2026-10-03T00:00:00Z", source: "tunnel", stream: "stderr", message: "runtime-private-key local-private-token tunnel_private_fixture" }];
  const controller = {
    get lifecycleState() { return state; },
    start: async () => { starts++; state = "starting"; if (gate) await gate; state = "running"; },
    stop: async () => { stops++; state = "stopped"; },
    getStatus: async () => ({ state, bridge: state === "running" ? "running" : "stopped", mcp: "unavailable", tunnel: "disconnected" }),
    getLogs: () => logs,
    getCodexStatus: async () => ({ enabled: false, available: false, ipcConnected: false }),
    getCodexModuleBindings: async () => [], getLocalMcpServers: async () => [],
    loadLocalMcpServer: async () => ({}), unloadLocalMcpServer: async () => ({}), probeLocalMcpServer: async () => ({}), unbindCodexModule: async () => ({}),
  };
  const ui = await module.launchMacControlUi!(configPath, { openBrowser: false, controller: controller as never });
  t.after(async () => { release?.(); await ui.close(); await rm(root, { recursive: true, force: true }); });
  const url = new URL(ui.url), token = url.hash.slice(1), origin = url.origin;
  async function request(route: string, body?: unknown, headers: Record<string,string> = {}) {
    return fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { Origin: origin, "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  return { root, configPath, ui, origin, request, setLogs: (messages: string[]) => { logs = messages.map(message => ({ timestamp: "2026-10-03T00:00:00Z", source: "tunnel", stream: "stderr", message })); }, counts: () => ({ starts, stops }), hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => release?.() };
}

test("Mac console requires per-launch auth and blocks cross-origin/forged-host requests", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/snapshot")).status, 401);
  assert.equal((await f.request("/api/snapshot", undefined, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.request("/api/action", { action: "start" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.request("/api/action", { action: "start" }, { Origin: "" })).status, 403);
  const http = await import("node:http");
  const forged = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(f.origin + "/api/snapshot", { headers: { Host: "evil.example", Authorization: `Bearer ${new URL(f.ui.url).hash.slice(1)}` } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(forged, 403);
  assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
});

test("Mac console snapshot and served assets never expose runtime/config secrets", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/snapshot");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /runtime-private-key|local-private-token|tunnel_private_fixture/);
  const snapshot = JSON.parse(text);
  assert.equal(snapshot.workspaces[0].id, "mac");
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.configKey, undefined);
  for (const route of ["/", "/ui.css", "/ui.js"]) {
    const asset = await fetch(f.origin + route);
    assert.equal(asset.status, 200);
    assert.doesNotMatch(await asset.text(), /runtime-private-key|local-private-token/);
    assert.ok(asset.headers.get("content-security-policy"));
  }
});

test("Mac console dispatches fixed commands and refuses saves while running", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/action", { action: "execute", command: "unsafe" })).status, 400);
  assert.equal((await f.request("/api/action", { action: "start", extra: "unsafe" })).status, 400);
  assert.equal((await f.request("/api/action", { action: "start" })).status, 200);
  const snapshot = await (await f.request("/api/snapshot")).json();
  assert.equal((await f.request("/api/action", { action: "save-config", revision: snapshot.revision, workspaces: snapshot.workspaces })).status, 409);
  assert.equal((await f.request("/api/action", { action: "stop" })).status, 200);
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().stops, 1);
});

test("Mac console protects concurrent config changes and retains workspace policies", async t => {
  const f = await fixture(t);
  const snapshot = await (await f.request("/api/snapshot")).json();
  const original = JSON.parse(await readFile(f.configPath, "utf8"));
  await writeFile(f.configPath, JSON.stringify({ ...original, externallyEdited: true }));
  assert.equal((await f.request("/api/action", { action: "save-config", revision: snapshot.revision, workspaces: snapshot.workspaces })).status, 409);
  const fresh = await (await f.request("/api/snapshot")).json();
  assert.equal((await f.request("/api/action", { action: "save-config", revision: fresh.revision, workspaces: [{ ...fresh.workspaces[0], id: "renamed" }] })).status, 200);
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.equal(saved.externallyEdited, true); assert.equal(saved.auth.token, "local-private-token");
  assert.deepEqual(saved.workspaces[0].allowedScripts, ["test"]); assert.equal(saved.workspaces[0].mode, "trusted-dev");
});

test("Mac console serializes operations and closes services even during startup", async t => {
  const f = await fixture(t); f.hold();
  const start = f.request("/api/action", { action: "start" });
  for (let i=0;i<100 && f.counts().starts===0;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal((await f.request("/api/action", { action: "start" })).status, 409);
  const closed = f.ui.close(); f.release(); await start.catch(() => undefined); await closed;
  assert.equal(f.counts().stops, 1);
  await assert.rejects(fetch(f.origin + "/api/snapshot"));
});

test("native UI host pipe EOF stops a running Bridge and detached Tunnel", { skip: process.platform === "win32" }, async t => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createInterface } = await import("node:readline");
  const http = await import("node:http");
  const { configFileTemplate } = await import("../src/config.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-native-host-"));
  let child: ReturnType<typeof spawn> | undefined, pid: number | undefined;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  async function port(): Promise<number> {
    const server=http.createServer(); server.listen(0,"127.0.0.1"); await once(server,"listening");
    const result=(server.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(r=>server.close(()=>r())); return result;
  }
  const healthPort=await port(), bridgePort=await port(), marker=path.join(root,"tunnel.pid"), executable=path.join(root,"tunnel-fixture");
  await writeFile(executable, `#!${process.execPath}\nrequire('node:http').createServer((req,res)=>res.end('ready')).listen(${healthPort},'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)));\n`, {mode:0o700});
  const config=JSON.parse(configFileTemplate());config.port=bridgePort;config.workspaces=[{id:"fixture",root}];config.tunnel={clientPath:executable,profile:"fixture",healthUrl:`http://127.0.0.1:${healthPort}`};
  const configPath=path.join(root,"mcp-bridge.json");await writeFile(configPath,JSON.stringify(config));await writeFile(path.join(root,".env"),"CONTROL_PLANE_API_KEY=test-only-key\n");
  child=spawn(process.execPath,["--import","tsx","src/ui/mac-app-host.ts","--config",configPath],{stdio:["pipe","pipe","ignore"]});
  const lines=createInterface({input:child.stdout!});const [line]=await once(lines,"line");lines.close();
  const url=new URL(JSON.parse(String(line)).url);
  const response=await fetch(url.origin+"/api/action",{method:"POST",headers:{Authorization:`Bearer ${url.hash.slice(1)}`,Origin:url.origin,"Content-Type":"application/json"},body:JSON.stringify({action:"start"})});
  assert.equal(response.status,200);await response.body?.cancel();
  pid=Number(await readFile(marker,"utf8"));
  const closed=once(child,"close");child.stdin!.end();await closed;
  let alive=true;try{process.kill(pid,0);}catch{alive=false;}
  assert.equal(alive,false,"native app crash/pipe close must not leave Tunnel alive");
  await assert.rejects(fetch(url.origin+"/api/snapshot"));
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/health`));
});


test("Mac snapshots redact credentials split across process output chunks", async t => {
  const f = await fixture(t); f.setLogs(["runtime-private-", "key", "local-private-", "token"]);
  const snapshot = await (await f.request("/api/snapshot")).json();
  const joined = snapshot.logs.map((log: {message:string}) => log.message).join("");
  assert.doesNotMatch(joined, /runtime-private-key|local-private-token/);
});
