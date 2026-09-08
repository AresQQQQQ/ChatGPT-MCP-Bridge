import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { CommandPolicyError, RecipeRunner } from "../src/commands/index.js";

test("RecipeRunner executes only fixed configured argv with bounded cwd and timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-recipe-runner-"));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  try {
    const runner = new RecipeRunner();
    const result = await runner.run("unit", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({argv: process.argv.slice(1), cwd: process.cwd()}))", "fixed-value"],
      cwd: "nested",
      timeoutMs: 2_000,
    }, root);

    assert.equal(result.outcome, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.recipeId, "unit");
    assert.equal(result.cwd, nested);
    const payload = JSON.parse(result.stdout) as { argv: string[]; cwd: string };
    assert.deepEqual(payload.argv, ["fixed-value"]);
    assert.equal(payload.cwd, nested);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RecipeRunner refuses an executable that is writable through the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-recipe-local-exe-"));
  try {
    const executable = path.join(root, process.platform === "win32" ? "fake.exe" : "fake");
    await writeFile(executable, "not executable", "utf8");
    if (process.platform !== "win32") await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755));

    await assert.rejects(
      new RecipeRunner().run("unsafe", { executable, args: [] }, root),
      (error: unknown) => error instanceof CommandPolicyError && /outside the writable workspace/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RecipeRunner enforces workspace-relative cwd and configured timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-recipe-timeout-"));
  try {
    const runner = new RecipeRunner();
    await assert.rejects(
      runner.run("bad-cwd", { executable: process.execPath, args: [], cwd: "../outside" }, root),
      CommandPolicyError,
    );

    const timed = await runner.run("timeout", {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    }, root);
    assert.equal(timed.outcome, "timed-out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
