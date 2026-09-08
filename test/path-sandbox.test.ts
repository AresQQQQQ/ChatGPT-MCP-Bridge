import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PathSecurityError } from "../src/security/path-sandbox.js";
import { WorkspaceRegistry } from "../src/workspaces/workspace-registry.js";

test("workspace registry reads files and rejects traversal", async () => {
  const tempRoot = await mkdtemp(path.join(process.cwd(), ".mcp-bridge-test-"));
  try {
    const workspaceRoot = path.join(tempRoot, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "hello.txt"), "hello bridge\n", "utf8");
    await writeFile(path.join(tempRoot, "secret.txt"), "outside\n", "utf8");

    const registry = await WorkspaceRegistry.create({
      workspaces: [{ id: "demo", root: workspaceRoot }],
      maxReadBytes: 1024,
    });

    const result = await registry.readFile("demo", "hello.txt");
    assert.equal(result.content, "hello bridge\n");
    await assert.rejects(
      registry.readFile("demo", "../secret.txt"),
      (error: unknown) => error instanceof PathSecurityError,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace registry enforces the configured read limit", async () => {
  const tempRoot = await mkdtemp(path.join(process.cwd(), ".mcp-bridge-test-"));
  try {
    await writeFile(path.join(tempRoot, "large.txt"), "0123456789", "utf8");
    const registry = await WorkspaceRegistry.create({
      workspaces: [{ id: "demo", root: tempRoot }],
      maxReadBytes: 4,
    });

    await assert.rejects(registry.readFile("demo", "large.txt"), /exceeds/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
