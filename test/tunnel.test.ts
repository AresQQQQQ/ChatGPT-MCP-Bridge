import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTunnelSpawnSpec, launchTunnel } from "../src/tunnel.js";

test("tunnel launch is shell-free and forwards local MCP auth without placing secrets in argv", () => {
  const clientPath = path.resolve("tools", "tunnel-client.exe");
  const token = "secret-local-bridge-token";
  const spec = buildTunnelSpawnSpec(
    { clientPath, profile: "web-test", healthUrl: "http://127.0.0.1:8081" },
    { token },
    { CONTROL_PLANE_API_KEY: "runtime-key", PATH: "test-path" },
  );

  assert.equal(spec.executable, clientPath);
  assert.deepEqual(spec.args, ["run", "--profile", "web-test"]);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.env.CONTROL_PLANE_API_KEY, "runtime-key");
  assert.equal(spec.env.LOG_LEVEL, "warn");
  assert.equal(spec.env.MCP_EXTRA_HEADERS, `Authorization: Bearer ${token}`);
  assert.equal(spec.env.MCP_DISCOVERY_EXTRA_HEADERS, `Authorization: Bearer ${token}`);
  assert.doesNotMatch(spec.args.join(" "), /runtime-key|secret-local-bridge-token/);
});

test("tunnel refuses to reuse an already-ready endpoint without verified process ownership", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    await assert.rejects(
      launchTunnel({
        clientPath: path.resolve("tools", "tunnel-client"),
        profile: "other-profile",
        healthUrl: "http://127.0.0.1:8081",
      }),
      /cannot verify that it belongs to the configured Tunnel profile.*Refusing to reuse or terminate an unknown Tunnel/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
