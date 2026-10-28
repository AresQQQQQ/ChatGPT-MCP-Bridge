import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("macOS workspace tree uses permission-specific labels and shows each workspace Module count", async () => {
  const js = await readFile(path.resolve("assets/mac-console/ui.js"), "utf8");
  const css = await readFile(path.resolve("assets/mac-console/ui.css"), "utf8");

  assert.ok(js.includes("const modeClasses ="), "permission modes have explicit visual classes");
  assert.ok(js.includes('modeClasses[w.mode] || "mode-workspace"'), "workspace rows use the permission class");
  assert.ok(js.includes('title="${modules.length} Codex Modules"'), "workspace rows expose the Module count");
  for (const mode of ["readonly", "workspace", "trusted-dev", "handoff"]) {
    assert.ok(css.includes(".tree-row .small.mode-" + mode), "missing " + mode + " permission styling");
  }
});

test("macOS logs classify severity and style errors, warnings, and debug messages", async () => {
  const js = await readFile(path.resolve("assets/mac-console/ui.js"), "utf8");
  const css = await readFile(path.resolve("assets/mac-console/ui.css"), "utf8");

  assert.ok(js.includes("function logTone(log)"), "log severity parser exists");
  assert.ok(js.includes("level-${logTone(log)}"), "log severity is attached to rendered rows");
  assert.ok(css.includes(".log-row.level-error .log-message"));
  assert.ok(css.includes(".log-row.level-warn .log-message"));
  assert.ok(css.includes(".log-row.level-debug .log-message"));
});