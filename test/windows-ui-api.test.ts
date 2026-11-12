import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { launchWindowsUiApi } from "../src/ui/windows-ui-api.js";

const windowsOnly = { skip: process.platform !== "win32" };

test("Windows local UI API requires its launch token and exact loopback origin", windowsOnly, async t => {
  let calls = 0;
  const api = await launchWindowsUiApi({
    onConnectionSetup: async () => { calls++; },
  });
  t.after(async () => api.close());

  const body = JSON.stringify({ tunnelId: "tunnel_local_ui_test", runtimeKey: "" });
  const post = (headers: Record<string, string>) => fetch(api.origin + "/api/connection/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post({
    Authorization: `Bearer ${api.token}`,
    Origin: "https://evil.example",
  })).status, 403);

  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(api.origin + "/api/connection/setup", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api.token}`,
        "Content-Type": "application/json",
        Host: "evil.example",
      },
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end(body);
  });

  assert.equal(forgedHostStatus, 403);
  assert.equal(calls, 0);
});

test("Windows connection API validates inputs, redacts runtime keys, and dispatches both operations", windowsOnly, async t => {
  let settingsInput: unknown;
  let setupInput: unknown;
  const runtimeKey = "runtime-key-never-echo-this-fixture";
  const api = await launchWindowsUiApi({
    onConnectionSettings: async input => {
      settingsInput = input;
      throw new Error(`test failure with key ${input.runtimeKey ?? ""}`);
    },
    onConnectionSetup: async input => { setupInput = input; },
  });
  t.after(async () => api.close());

  const post = (route: string, body: unknown) => fetch(api.origin + route, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${api.token}`,
      Origin: api.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const settings = await post("/api/connection/settings", {
    runtimeKey,
    tunnelId: "tunnel_connection_fixture",
    bridgePort: 3001,
    healthPort: 8081,
  });
  assert.equal(settings.status, 400);
  assert.deepEqual(settingsInput, {
    runtimeKey,
    tunnelId: "tunnel_connection_fixture",
    bridgePort: 3001,
    healthPort: 8081,
  });
  const settingsBody = await settings.text();
  assert.match(settingsBody, /\[已隐藏\]/u);
  assert.doesNotMatch(settingsBody, new RegExp(runtimeKey));

  const setup = await post("/api/connection/setup", {
    tunnelId: "tunnel_connection_fixture",
    runtimeKey: "",
  });
  assert.equal(setup.status, 200);
  assert.deepEqual(setupInput, { tunnelId: "tunnel_connection_fixture", runtimeKey: "" });

  assert.equal((await post("/api/connection/settings", {
    runtimeKey,
    tunnelId: "tunnel_connection_fixture",
    bridgePort: 3001,
    healthPort: 8081,
    unexpected: true,
  })).status, 400);
});
