import assert from "node:assert/strict";
import { test } from "node:test";
import { launchLocalControlUi } from "../src/ui/windows-console.js";

test("non-Windows UI reports Terminal startup guidance without launching WPF", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(launchLocalControlUi("missing-config.json"), /图形控制台目前仅支持 Windows。\nmacOS 请使用 bridge.command 或 pnpm start。/);
});

test("SIGINT during CLI startup cleans the detached Tunnel process", { skip: process.platform === "win32" }, async t => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { once } = await import("node:events");
  const { default: path } = await import("node:path");
  const { default: os } = await import("node:os");
  const { default: http } = await import("node:http");
  const { configFileTemplate } = await import("../src/config.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-start-signal-"));
  let tunnelPid: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (tunnelPid) { try { process.kill(-tunnelPid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  async function freePort(): Promise<number> {
    const server = http.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve())); return port;
  }
  const healthPort = await freePort();
  const client = path.join(root, "fake-tunnel");
  const marker = path.join(root, "pid");
  await writeFile(client, `#!${process.execPath}\nconst http = require('node:http'); const fs = require('node:fs'); let ready=false; setTimeout(()=>ready=true,300); http.createServer((req,res)=>{res.statusCode=ready?200:503;res.end('ready')}).listen(${healthPort},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)));\n`, { mode: 0o700 });
  const configPath = path.join(root, "mcp-bridge.json");
  const config = JSON.parse(configFileTemplate());
  config.port = await freePort();
  config.workspaces = [{ id: "test", root }];
  config.tunnel = { clientPath: client, profile: "fixture", healthUrl: `http://127.0.0.1:${healthPort}` };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(root, ".env"), "CONTROL_PLANE_API_KEY=dummy-test-key\n");
  child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "start", "--config", configPath], { stdio: "ignore" });
  const closed = once(child, "close");
  for (let attempt = 0; attempt < 200; attempt++) {
    tunnelPid = await readFile(marker, "utf8").then(Number).catch(() => undefined);
    if (tunnelPid) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(tunnelPid, "fixture Tunnel launched");
  child.kill("SIGINT");
  const [code, signal] = await closed;
  let alive = true; try { process.kill(tunnelPid, 0); } catch { alive = false; }
  assert.equal(alive, false, "Tunnel must not survive startup interruption");
  assert.equal(code, 0); assert.equal(signal, null);
});
