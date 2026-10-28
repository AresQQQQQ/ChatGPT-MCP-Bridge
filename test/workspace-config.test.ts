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


test("workspace config refuses a stale expected document without overwriting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-cas-"));
  try {
    const configPath = path.join(root, "mcp-bridge.json");
    const original = JSON.stringify({ workspaces: [{ id: "mac", root }] });
    const updated = JSON.stringify({ workspaces: [{ id: "mac", root }], changedElsewhere: true });
    await writeFile(configPath, updated);
    await assert.rejects(writeWorkspaceConfig(configPath, [{ originalId: "mac", id: "renamed", root, mode: "workspace" }], original), /其他程序修改/);
    assert.equal(await readFile(configPath, "utf8"), updated);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("workspace config saves global Codex defaults while preserving the rest of mcp-bridge.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-codex-defaults-"));
  try {
    const workspaceRoot = path.join(root, "project");
    await mkdir(workspaceRoot);
    const configPath = path.join(root, "mcp-bridge.json");
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      auth: { token: "keep-this-token" },
      tunnel: { profile: "keep-this-profile" },
      codex: { clientPath: "tools/codex.exe", customOption: "keep-this-option" },
      workspaces: [{ id: "demo", root: "project", mode: "workspace", allowedScripts: ["test"], custom: "keep-this-workspace-field" }],
    }, null, 2), "utf8");

    const snapshot = await readWorkspaceConfig(configPath);
    await writeWorkspaceConfig(configPath, snapshot.workspaces, {
      expectedKey: snapshot.key,
      codexDefaults: { defaultModel: "gpt-6-luna", defaultEffort: "high" },
    });

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly host: string;
      readonly auth: unknown;
      readonly tunnel: unknown;
      readonly codex: Record<string, unknown>;
      readonly workspaces: readonly Record<string, unknown>[];
    };
    assert.equal(saved.host, "127.0.0.1");
    assert.deepEqual(saved.auth, { token: "keep-this-token" });
    assert.deepEqual(saved.tunnel, { profile: "keep-this-profile" });
    assert.deepEqual(saved.codex, {
      clientPath: "tools/codex.exe",
      customOption: "keep-this-option",
      defaultModel: "gpt-6-luna",
      defaultEffort: "high",
    });
    assert.equal(saved.workspaces[0].custom, "keep-this-workspace-field");
    assert.equal(saved.workspaces[0].root, "project", "saving only Codex defaults must preserve the project's relative path");
    const reloaded = await readWorkspaceConfig(configPath);
    assert.deepEqual(reloaded.codexDefaults, { defaultModel: "gpt-6-luna", defaultEffort: "high" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace config rejects invalid Codex defaults and stale snapshots without writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-codex-conflict-"));
  try {
    const workspaceRoot = path.join(root, "project");
    await mkdir(workspaceRoot);
    const configPath = path.join(root, "mcp-bridge.json");
    await writeFile(configPath, JSON.stringify({
      codex: { defaultModel: "gpt-6-luna", defaultEffort: "max" },
      workspaces: [{ id: "demo", root: workspaceRoot }],
    }), "utf8");
    const snapshot = await readWorkspaceConfig(configPath);
    const original = await readFile(configPath, "utf8");

    await assert.rejects(writeWorkspaceConfig(configPath, snapshot.workspaces, {
      expectedKey: snapshot.key,
      codexDefaults: { defaultModel: "bad model", defaultEffort: "max" },
    }), /模型 ID 无效/u);
    assert.equal(await readFile(configPath, "utf8"), original);

    const concurrentContent = JSON.stringify({
      codex: { defaultModel: "external-model", defaultEffort: "low" },
      externalSetting: "keep-this-update",
      workspaces: [{ id: "demo", root: workspaceRoot }],
    }, null, 2);
    await writeFile(configPath, concurrentContent, "utf8");
    await assert.rejects(writeWorkspaceConfig(configPath, snapshot.workspaces, {
      expectedKey: snapshot.key,
      codexDefaults: { defaultModel: "gpt-6-luna", defaultEffort: "max" },
    }), /配置已被其他操作修改/u);
    assert.equal(await readFile(configPath, "utf8"), concurrentContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

});
