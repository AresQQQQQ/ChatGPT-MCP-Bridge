import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorktreeCheckpointStore } from "../src/git/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-checkpoint-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "checkpoint@example.invalid"]);
  await git(root, ["config", "user.name", "Checkpoint Tests"]);
  await writeFile(path.join(root, "tracked.txt"), "initial\n", "utf8");
  await writeFile(path.join(root, "stable.txt"), "stable\n", "utf8");
  await git(root, ["add", "tracked.txt", "stable.txt"]);
  await git(root, ["commit", "-qm", "initial"]);
  return root;
}

test("worktree checkpoint distinguishes pre-existing, additionally modified, and newly dirty paths", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "tracked.txt"), "pre-existing\n", "utf8");
    await writeFile(path.join(root, "existing-untracked.txt"), "existing\n", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=blocked\n", "utf8");

    const store = new WorktreeCheckpointStore();
    const checkpoint = await store.create("demo", root);
    assert.equal(checkpoint.dirtyPaths, 2);
    assert.equal(checkpoint.ignoredPaths, 0);
    assert.ok(checkpoint.head);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(path.join(root, "tracked.txt"), "modified-again\n", "utf8");
    await writeFile(path.join(root, "new-task.txt"), "new\n", "utf8");

    const compared = await store.compare("demo", root, checkpoint.checkpointId);
    assert.equal(compared.headChanged, false);
    assert.deepEqual(compared.preExistingAdditionallyModified, ["tracked.txt"]);
    assert.deepEqual(compared.preExistingUnchanged, ["existing-untracked.txt"]);
    assert.deepEqual(compared.addedByTask, ["new-task.txt"]);
    assert.deepEqual(compared.resolvedPreExisting, []);
    assert.equal(compared.addedByTask.includes(".env"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree checkpoint reports resolved dirty state and HEAD changes", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "tracked.txt"), "dirty\n", "utf8");
    const store = new WorktreeCheckpointStore();
    const checkpoint = await store.create("demo", root);

    await writeFile(path.join(root, "tracked.txt"), "initial\n", "utf8");
    await writeFile(path.join(root, "new-commit.txt"), "commit\n", "utf8");
    await git(root, ["add", "new-commit.txt"]);
    await git(root, ["commit", "-qm", "advance head"]);

    const compared = await store.compare("demo", root, checkpoint.checkpointId);
    assert.equal(compared.headChanged, true);
    assert.deepEqual(compared.resolvedPreExisting, ["tracked.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
