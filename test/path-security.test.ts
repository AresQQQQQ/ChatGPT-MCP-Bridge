import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { isPathContained, PathSecurityError, PathSandbox } from "../src/security/path-sandbox.js";
import { WorkspaceRegistry, WorkspaceUnavailableError } from "../src/workspaces/workspace-registry.js";

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeRegistry(root: string, mode?: "readonly" | "workspace" | "handoff"): Promise<WorkspaceRegistry> {
  return WorkspaceRegistry.create({
    workspaces: [{ id: "demo", root, ...(mode ? { mode } : {}) }],
    maxReadBytes: 1024,
  });
}

test("lexical containment is segment-aware and Windows case-insensitive", () => {
  assert.equal(isPathContained("/workspace", "/workspace/file.ts", "posix"), true);
  assert.equal(isPathContained("/workspace", "/workspace-evil/file.ts", "posix"), false);
  assert.equal(isPathContained("C:\\Workspace", "c:\\workspace\\file.ts", "win32"), true);
  assert.equal(isPathContained("C:\\Workspace", "C:\\Workspace-evil\\file.ts", "win32"), false);
});

test("rejects absolute, traversal, repeated separator, NUL, and missing-parent paths", async () => {
  const root = await makeRoot("mcp-bridge-security-");
  await writeFile(path.join(root, "safe.txt"), "safe", "utf8");
  const registry = await makeRegistry(root);

  const invalidPaths = [
    path.join(root, "safe.txt"),
    "../safe.txt",
    "nested/../safe.txt",
    "nested//safe.txt",
    "safe\0.txt",
  ];
  for (const invalidPath of invalidPaths) {
    await assert.rejects(
      registry.readFile("demo", invalidPath),
      (error: unknown) => error instanceof PathSecurityError,
    );
  }

  await assert.rejects(
    registry.writeFile("demo", "missing/leaf.txt", "nope"),
    (error: unknown) => error instanceof PathSecurityError && error.code === "MISSING_PARENT",
  );
});

test("blocks sensitive files and build/cache trees from reads and listings", async () => {
  const root = await makeRoot("mcp-bridge-blocked-");
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".ssh"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, "build"));
  await mkdir(path.join(root, ".mcp-bridge-state"));
  await writeFile(path.join(root, ".env"), "TOKEN=secret", "utf8");
  await writeFile(path.join(root, ".env.local"), "TOKEN=secret", "utf8");
  await writeFile(path.join(root, ".git", "config"), "secret", "utf8");
  await writeFile(path.join(root, ".ssh", "config"), "secret", "utf8");
  await writeFile(path.join(root, "node_modules", "package.js"), "secret", "utf8");
  await writeFile(path.join(root, "build", "output.js"), "secret", "utf8");
  await writeFile(path.join(root, ".mcp-bridge-state", "codex.json"), "secret", "utf8");
  await writeFile(path.join(root, "private.pem"), "secret", "utf8");
  await writeFile(path.join(root, "id_ed25519"), "secret", "utf8");
  await writeFile(path.join(root, "safe.ts"), "export const safe = true;", "utf8");
  const registry = await makeRegistry(root);

  const entries = await registry.listDirectory("demo");
  assert.deepEqual(entries.map((entry) => entry.name), ["safe.ts"]);
  for (const blocked of [".env", ".env.local", ".git/config", ".ssh/config", "node_modules/package.js", "build/output.js", ".mcp-bridge-state/codex.json", "private.pem", "id_ed25519"]) {
    await assert.rejects(
      registry.readFile("demo", blocked),
      (error: unknown) => error instanceof PathSecurityError && error.code === "SENSITIVE_PATH",
    );
  }
});

test("rejects workspaces nested beneath blocked directory names", async () => {
  const parent = await makeRoot("mcp-bridge-blocked-root-");
  for (const blockedDirectory of [".git", ".ssh", "node_modules"] as const) {
    const root = path.join(parent, blockedDirectory, "project");
    await mkdir(root, { recursive: true });
    await assert.rejects(
      makeRegistry(root),
      (error: unknown) => error instanceof WorkspaceUnavailableError,
    );
  }
});

test("rejects symlink escapes, symlink leaves, and symlink parents", async () => {
  const root = await makeRoot("mcp-bridge-symlink-");
  const outside = await makeRoot("mcp-bridge-outside-");
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  await mkdir(path.join(outside, "dir"));
  await writeFile(path.join(outside, "dir", "secret.txt"), "outside", "utf8");
  await writeFile(path.join(root, "safe.txt"), "inside", "utf8");

  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await symlink(path.join(outside, "dir"), path.join(root, "linked-dir"), process.platform === "win32" ? "junction" : undefined);
  } catch {
    // Windows without symlink/junction privileges cannot exercise this case.
    return;
  }

  const registry = await makeRegistry(root);
  await assert.rejects(registry.readFile("demo", "link.txt"), /outside|symlink|Path/);
  await assert.rejects(registry.readFile("demo", "linked-dir/secret.txt"), /outside|symlink|Path/);
  await assert.rejects(registry.writeFile("demo", "link.txt", "overwrite"), PathSecurityError);
  assert.deepEqual((await registry.listDirectory("demo")).map((entry) => entry.name), ["safe.txt"]);

  await assert.rejects(
    registry.writeFile("demo", "linked-dir/new.txt", "nope"),
    (error: unknown) => error instanceof PathSecurityError,
  );
});

test("readonly and handoff roots cannot be modified, workspace can", async () => {
  const base = await makeRoot("mcp-bridge-modes-");
  const readonlyRoot = path.join(base, "readonly");
  const workspaceRoot = path.join(base, "workspace");
  const handoffRoot = path.join(base, "handoff");
  await mkdir(readonlyRoot);
  await mkdir(workspaceRoot);
  await mkdir(handoffRoot);
  await writeFile(path.join(readonlyRoot, "readme.txt"), "read only", "utf8");
  await writeFile(path.join(handoffRoot, "artifact.txt"), "artifact", "utf8");

  const registry = await WorkspaceRegistry.create({
    workspaces: [
      { id: "readonly", root: readonlyRoot, mode: "readonly" },
      { id: "workspace", root: workspaceRoot, mode: "workspace" },
      { id: "handoff", root: handoffRoot, mode: "handoff" },
    ],
    maxReadBytes: 1024,
  });

  assert.equal((await registry.readFile("readonly", "readme.txt")).content, "read only");
  assert.equal((await registry.readFile("handoff", "artifact.txt")).content, "artifact");
  await assert.rejects(registry.writeFile("readonly", "new.txt", "nope"), PathSecurityError);
  await assert.rejects(registry.writeFile("handoff", "new.txt", "nope"), PathSecurityError);
  await registry.writeFile("workspace", "new.txt", "allowed");
  assert.equal((await registry.readFile("workspace", "new.txt")).content, "allowed");
});

test("PathSandbox rejects Windows drive-relative, UNC, device, and ADS forms", async () => {
  if (process.platform !== "win32") return;
  const root = await makeRoot("mcp-bridge-windows-");
  const sandbox = await PathSandbox.create([{ id: "demo", path: root, mode: "workspace" }]);
  for (const relativePath of [
    "C:relative.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\outside.txt",
    "\\\\.\\PIPE\\name",
    "file.txt:secret",
  ]) {
    await assert.rejects(
      sandbox.resolve({ rootId: "demo", relativePath, operation: "read" }),
      PathSecurityError,
    );
  }
});
