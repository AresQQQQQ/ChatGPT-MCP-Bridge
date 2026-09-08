import assert from "node:assert/strict";
import { test } from "node:test";

import { CommandPolicyError, ProcessInspector } from "../src/commands/index.js";

test("ProcessInspector inspects the current Windows process without exposing command line", { skip: process.platform !== "win32" }, async () => {
  const inspector = new ProcessInspector();
  const current = await inspector.inspect(process.pid);
  assert.ok(current);
  assert.equal(current.pid, process.pid);
  assert.ok(current.name.length > 0);
  assert.ok(Number.isInteger(current.ppid));
  assert.ok(Number.isInteger(current.windowsSessionId));
  assert.equal("commandLine" in current, false);
  assert.equal("environment" in current, false);

  const matches = await inspector.findByName(current.name);
  assert.equal(matches.some((candidate) => candidate.pid === process.pid), true);
});

test("ProcessInspector rejects unsafe names and reports a missing PID", { skip: process.platform !== "win32" }, async () => {
  const inspector = new ProcessInspector();
  await assert.rejects(inspector.findByName("node.exe'; Stop-Process -Id 1"), CommandPolicyError);
  assert.equal(await inspector.inspect(0x7ffffffe), undefined);
});

test("ProcessInspector waitForExit is bounded and does not terminate a live process", { skip: process.platform !== "win32" }, async () => {
  const inspector = new ProcessInspector();
  const result = await inspector.waitForExit(process.pid, 200, 100);
  assert.equal(result.pid, process.pid);
  assert.equal(result.exited, false);
  assert.ok(result.elapsedMs >= 100);
});
