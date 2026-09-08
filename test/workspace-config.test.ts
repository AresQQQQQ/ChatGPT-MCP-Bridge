import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readWorkspaceConfig, writeWorkspaceConfig } from "../src/ui/workspace-config.js";

test("workspace config edits only workspaces and preserves existing workspace policy fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-config-"));
  try {
    const existingRoot = path.join(root, "existing");
    const addedRoot = path.join(root, "added");
    await Promise.all([mkdir(existingRoot), mkdir(addedRoot)]);
    const configPath = path.join(root, "mcp-bridge.json");
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 3000,
      tunnel: { profile: "keep-me" },
      codex: {},
      workspaces: [{ id: "old", root: existingRoot, mode: "readonly", allowedScripts: ["test"], codex: { enabled: false }, custom: "keep" }],
    }, null, 2));

    await writeWorkspaceConfig(configPath, [
      { originalId: "old", id: "renamed", root: existingRoot, mode: "trusted-dev" },
      { id: "added", root: addedRoot, mode: "workspace" },
    ]);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      tunnel: { profile: string };
      workspaces: Array<Record<string, unknown>>;
    };
    assert.equal(saved.tunnel.profile, "keep-me");
    assert.deepEqual(saved.workspaces[0], {
      id: "renamed",
      root: existingRoot,
      mode: "trusted-dev",
      allowedScripts: ["test"],
      codex: { enabled: false },
      custom: "keep",
    });
    assert.deepEqual(saved.workspaces[1], {
      id: "added",
      root: addedRoot,
      mode: "workspace",
      allowedScripts: ["test", "build", "lint", "typecheck"],
      codex: { enabled: true },
    });

    const snapshot = await readWorkspaceConfig(configPath);
    assert.deepEqual(snapshot.workspaces.map(({ id, root: workspaceRoot, mode }) => ({ id, root: workspaceRoot, mode })), [
      { id: "renamed", root: existingRoot, mode: "trusted-dev" },
      { id: "added", root: addedRoot, mode: "workspace" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace config rejects duplicate ids, invalid ids, missing folders, and deleting all projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-config-invalid-"));
  try {
    const existingRoot = path.join(root, "existing");
    await mkdir(existingRoot);
    const configPath = path.join(root, "mcp-bridge.json");
    await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "bridge", root: existingRoot }] }));

    await assert.rejects(
      writeWorkspaceConfig(configPath, [{ id: "same", root: existingRoot, mode: "workspace" }, { id: "same", root: existingRoot, mode: "workspace" }]),
      /项目 ID 重复/u,
    );
    await assert.rejects(writeWorkspaceConfig(configPath, [{ id: "bad id", root: existingRoot, mode: "workspace" }]), /项目 ID 无效/u);
    await assert.rejects(writeWorkspaceConfig(configPath, [{ id: "missing", root: path.join(root, "missing"), mode: "workspace" }]), /项目文件夹不存在/u);
    await assert.rejects(writeWorkspaceConfig(configPath, [{ id: "bridge", root: existingRoot, mode: "invalid" as "workspace" }]), /权限模式无效/u);
    await assert.rejects(writeWorkspaceConfig(configPath, []), /至少保留一个项目/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
