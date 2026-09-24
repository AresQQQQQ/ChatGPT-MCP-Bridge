import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { PathSecurityError } from "../src/security/path-sandbox.js";
import {
  PatchApplicationError,
  WorkspaceFileError,
  WorkspaceRegistry,
} from "../src/workspaces/workspace-registry.js";

async function makeRegistry(maxReadBytes = 4096): Promise<{ root: string; registry: WorkspaceRegistry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-files-"));
  const registry = await WorkspaceRegistry.create({
    workspaces: [{ id: "demo", root }],
    maxReadBytes,
  });
  return { root, registry };
}

test("listDirectory omits blocked entries and search traverses safe files", async () => {
  const { root, registry } = await makeRegistry();
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "src", "alpha.ts"), "export const needle = true;\n", "utf8");
  await writeFile(path.join(root, "src", "beta.txt"), "ordinary text\n", "utf8");
  await writeFile(path.join(root, "node_modules", "needle.js"), "must not be searched", "utf8");

  const rootEntries = await registry.listDirectory("demo");
  assert.deepEqual(rootEntries.map((entry) => entry.name), ["src"]);
  const contentMatches = await registry.search("demo", "needle");
  assert.deepEqual(contentMatches.results.map((entry) => entry.path), [path.join("src", "alpha.ts")]);
  assert.equal(contentMatches.truncated, false);
  const nameMatches = await registry.search("demo", "beta");
  assert.deepEqual(nameMatches.results.map((entry) => entry.path), [path.join("src", "beta.txt")]);
});

test("directory/search pagination, stat hashes, and glob discovery are stable", async () => {
  const { root, registry } = await makeRegistry();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "a.txt"), "needle a", "utf8");
  await writeFile(path.join(root, "b.txt"), "needle b", "utf8");
  await writeFile(path.join(root, "src", "one.test.ts"), "export {};", "utf8");
  await writeFile(path.join(root, "src", "two.ts"), "export {};", "utf8");

  const firstDirectory = await registry.listDirectoryPage("demo", ".", { limit: 1 });
  assert.equal(firstDirectory.entries.length, 1);
  assert.equal(firstDirectory.truncated, true);
  assert.ok(firstDirectory.nextCursor);
  const secondDirectory = await registry.listDirectoryPage("demo", ".", { limit: 10, cursor: firstDirectory.nextCursor });
  assert.equal(secondDirectory.entries.some((entry) => entry.name === firstDirectory.entries[0]?.name), false);

  const firstSearch = await registry.search("demo", "needle", { maxResults: 1 });
  assert.equal(firstSearch.results.length, 1);
  assert.equal(firstSearch.truncated, true);
  assert.ok(firstSearch.nextCursor);
  const secondSearch = await registry.search("demo", "needle", { maxResults: 1, cursor: firstSearch.nextCursor });
  assert.equal(secondSearch.results.length, 1);
  assert.notEqual(secondSearch.results[0]?.path, firstSearch.results[0]?.path);

  const stats = await registry.statFile("demo", "a.txt", { includeHash: true });
  assert.equal(stats.kind, "file");
  assert.equal(stats.size, 8);
  assert.equal(stats.contentHash, createHash("sha256").update("needle a").digest("hex"));
  assert.equal(typeof stats.mtimeMs, "number");

  const binaryBytes = Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x80]);
  await writeFile(path.join(root, "binary.dat"), binaryBytes);
  const binaryStats = await registry.statFile("demo", "binary.dat", { includeHash: true });
  assert.equal(binaryStats.contentHash, createHash("sha256").update(binaryBytes).digest("hex"));

  const found = await registry.findFiles("demo", "**/*.test.ts");
  assert.deepEqual(found.results.map((entry) => entry.path), [path.join("src", "one.test.ts")]);
  assert.equal(found.truncated, false);
  await assert.rejects(registry.findFiles("demo", "../*.ts"), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "INVALID_GLOB");
});

test("batch read/stat tools preserve per-file safety and aggregate bounds", async () => {
  const { root, registry } = await makeRegistry(32);
  await writeFile(path.join(root, "one.txt"), "one", "utf8");
  await writeFile(path.join(root, "two.txt"), "two-two", "utf8");

  const read = await registry.readFiles("demo", ["one.txt", "two.txt"], 16);
  assert.equal(read.totalBytes, 10);
  assert.deepEqual(read.files.map((file) => file.content), ["one", "two-two"]);
  await assert.rejects(
    registry.readFiles("demo", ["one.txt", "two.txt"], 5),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE",
  );

  const stats = await registry.statFiles("demo", ["one.txt", "two.txt"], { includeHash: true });
  assert.equal(stats.files.length, 2);
  assert.equal(stats.files[0]?.contentHash, createHash("sha256").update("one").digest("hex"));
  assert.equal(stats.files[1]?.size, 7);
  await assert.rejects(
    registry.statFiles("demo", ["one.txt", "two.txt"], { includeHash: true, maxTotalHashBytes: 8 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE",
  );
});

test("tree snapshots compare hashes, missing files, and changed content", async () => {
  const { root, registry } = await makeRegistry(1024);
  await mkdir(path.join(root, "left"));
  await mkdir(path.join(root, "left", "nested"));
  await mkdir(path.join(root, "right"));
  await mkdir(path.join(root, "right", "nested"));
  await writeFile(path.join(root, "left", "same.txt"), "same", "utf8");
  await writeFile(path.join(root, "right", "same.txt"), "same", "utf8");
  await writeFile(path.join(root, "left", "nested", "changed.txt"), "left", "utf8");
  await writeFile(path.join(root, "right", "nested", "changed.txt"), "right", "utf8");
  await writeFile(path.join(root, "left", "only-left.txt"), "left-only", "utf8");
  await writeFile(path.join(root, "right", "only-right.txt"), "right-only", "utf8");

  const left = await registry.snapshotTree("demo", "left", { includeHash: true });
  const right = await registry.snapshotTree("demo", "right", { includeHash: true });
  assert.equal(left.files, 3);
  assert.equal(right.files, 3);
  assert.equal(left.hashedBytes, left.bytes);

  const compared = registry.compareTreeSnapshots("demo", left.snapshotId, right.snapshotId);
  assert.equal(compared.comparisonMode, "sha256");
  assert.ok(compared.identical >= 2); // same.txt plus the nested directory entry.
  assert.deepEqual(compared.changed, ["nested/changed.txt"]);
  assert.deepEqual(compared.missingLeft, ["only-right.txt"]);
  assert.deepEqual(compared.missingRight, ["only-left.txt"]);
  assert.equal(compared.truncated, false);
});

test("tree snapshots are bounded and can exclude blocked build/cache trees", async () => {
  const { root, registry } = await makeRegistry(1024);
  await mkdir(path.join(root, "source"));
  await mkdir(path.join(root, "source", "build"));
  await writeFile(path.join(root, "source", "keep.txt"), "keep", "utf8");
  await writeFile(path.join(root, "source", "build", "generated.txt"), "generated", "utf8");

  const safe = await registry.snapshotTree("demo", "source", { exclude: ["build/**"] });
  assert.equal(safe.files, 1);
  await assert.rejects(
    registry.snapshotTree("demo", "source", { exclude: ["build/**"], maxFiles: 1, includeHash: true, maxTotalHashBytes: 2 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "SNAPSHOT_LIMIT",
  );
  await mkdir(path.join(root, "source", "d1"));
  await mkdir(path.join(root, "source", "d1", "d2"));
  await assert.rejects(
    registry.snapshotTree("demo", "source", { exclude: ["build/**"], maxDirectories: 2 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "SNAPSHOT_LIMIT",
  );
  await assert.rejects(
    registry.snapshotTree("demo", "source", { exclude: ["build/**"], maxEntries: 2 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "SNAPSHOT_LIMIT",
  );
});

test("read and atomic write enforce limits and preserve regular files", async () => {
  const { root, registry } = await makeRegistry(8);
  await writeFile(path.join(root, "small.txt"), "small", "utf8");
  await writeFile(path.join(root, "large.txt"), "0123456789", "utf8");

  assert.equal((await registry.readFile("demo", "small.txt")).content, "small");
  await assert.rejects(registry.readFile("demo", "large.txt"), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE");
  const firstPage = await registry.readFile("demo", "large.txt", { offset: 0, limit: 6 });
  assert.deepEqual(firstPage, {
    workspaceId: "demo",
    path: "large.txt",
    content: "012345",
    bytes: 6,
    offset: 0,
    nextOffset: 6,
    totalBytes: 10,
    eof: false,
  });
  const secondPage = await registry.readFile("demo", "large.txt", { offset: firstPage.nextOffset, limit: 6 });
  assert.equal(secondPage.content, "6789");
  assert.equal(secondPage.eof, true);
  await assert.rejects(registry.readFile("demo", "large.txt", { limit: 9 }), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION");
  await writeFile(path.join(root, "unicode.txt"), "a🙂b", "utf8");
  const unicodeFirst = await registry.readFile("demo", "unicode.txt", { limit: 4 });
  assert.equal(unicodeFirst.content, "a");
  const unicodeSecond = await registry.readFile("demo", "unicode.txt", { offset: unicodeFirst.nextOffset, limit: 5 });
  assert.equal(unicodeSecond.content, "🙂b");
  await registry.writeFile("demo", "small.txt", "updated");
  assert.equal((await registry.readFile("demo", "small.txt")).content, "updated");
  await registry.writeFile({ workspaceId: "demo", path: "created.txt", content: new Uint8Array([97, 98, 99]) });
  assert.equal((await registry.readFile("demo", "created.txt")).content, "abc");
});

test("search scans files up to 2 MiB by default and allows bounded per-call overrides", async () => {
  const { root, registry } = await makeRegistry(4 * 1024 * 1024);
  const content = `${"x".repeat(600 * 1024)}\nlarge-search-needle\n`;
  await writeFile(path.join(root, "large-source.ts"), content, "utf8");

  const defaultSearch = await registry.search("demo", "large-search-needle");
  assert.deepEqual(defaultSearch.results.map((entry) => entry.path), ["large-source.ts"]);

  const smallSearch = await registry.search("demo", "large-search-needle", { maxFileBytes: 512 * 1024 });
  assert.deepEqual(smallSearch.results, []);

  const explicitSearch = await registry.search("demo", "large-search-needle", { maxFileBytes: 1024 * 1024 });
  assert.deepEqual(explicitSearch.results.map((entry) => entry.path), ["large-source.ts"]);
});

test("workspace read-limit override takes precedence over the global limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-workspace-override-"));
  const registry = await WorkspaceRegistry.create({
    maxReadBytes: 1024,
    workspaces: [{ id: "demo", root, maxReadBytes: 4096 }],
  });
  await writeFile(path.join(root, "large.txt"), "x".repeat(2048), "utf8");
  const file = await registry.readFile("demo", "large.txt");
  assert.equal(file.bytes, 2048);
  assert.equal(registry.listWorkspaces()[0]?.maxReadBytes, 4096);
});

test("chunked writes keep the target unchanged until atomic commit", async () => {
  const { root, registry } = await makeRegistry(1024);
  await writeFile(path.join(root, "large.txt"), "old-content", "utf8");
  const first = "a".repeat(350 * 1024);
  const second = "b".repeat(350 * 1024);
  const complete = first + second;
  const expectedHash = createHash("sha256").update(complete).digest("hex");

  const upload = await registry.beginChunkedWrite("demo", "large.txt", {
    totalBytes: Buffer.byteLength(complete),
    expectedHash,
  });
  assert.equal(upload.chunkSize, 512 * 1024);
  assert.equal(await readFile(path.join(root, "large.txt"), "utf8"), "old-content");

  const one = await registry.writeChunk("demo", upload.uploadId, 0, first);
  assert.equal(one.bytesReceived, Buffer.byteLength(first));
  await assert.rejects(
    registry.writeChunk("demo", upload.uploadId, 0, second),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION",
  );
  const two = await registry.writeChunk("demo", upload.uploadId, one.bytesReceived, second);
  assert.equal(two.bytesReceived, Buffer.byteLength(complete));
  assert.equal(await readFile(path.join(root, "large.txt"), "utf8"), "old-content");

  const committed = await registry.commitChunkedWrite("demo", upload.uploadId);
  assert.equal(committed.bytes, Buffer.byteLength(complete));
  assert.equal(committed.contentHash, expectedHash);
  assert.equal(await readFile(path.join(root, "large.txt"), "utf8"), complete);
});

test("workspace copies regular files without overwrite and keeps sandbox boundaries", async () => {
  const { root, registry } = await makeRegistry();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "source.bin"), Buffer.from([0, 1, 2, 255]));

  const copied = await registry.copyFile("demo", "src/source.bin", "src/copy.bin");
  assert.equal(copied.bytes, 4);
  assert.deepEqual(await readFile(path.join(root, "src", "copy.bin")), Buffer.from([0, 1, 2, 255]));

  await assert.rejects(
    registry.copyFile("demo", "src/source.bin", "src/copy.bin"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "PATH_EXISTS",
  );
  await assert.rejects(registry.copyFile("demo", "src", "src-copy"), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "NOT_A_FILE");
  await assert.rejects(registry.copyFile("demo", "src/source.bin", "../escape.bin"), PathSecurityError);
  await assert.rejects(registry.copyFile("demo", "src/source.bin", "dist/copy.bin"), PathSecurityError);
});

test("binary reads preserve raw bytes and enforce the safe size limit", async () => {
  const { root, registry } = await makeRegistry();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x41]);
  await writeFile(path.join(root, "image.bin"), bytes);

  const result = await registry.readBinaryFile("demo", "image.bin", 64);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(result.data, bytes);
  await assert.rejects(
    registry.readBinaryFile("demo", "image.bin", 4),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE",
  );
  await assert.rejects(registry.readBinaryFile("demo", "../outside.bin", 64), PathSecurityError);
});

test("workspace supports safe directory creation, move, and non-recursive deletion", async () => {
  const { root, registry } = await makeRegistry();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "before.txt"), "content", "utf8");

  await registry.createDirectory("demo", "src/new-dir");
  assert.equal((await registry.listDirectory("demo", "src")).some((entry) => entry.name === "new-dir"), true);
  await assert.rejects(
    registry.createDirectory("demo", "missing/child"),
    (error: unknown) => error instanceof PathSecurityError && error.code === "MISSING_PARENT",
  );

  await registry.movePath("demo", "src/before.txt", "src/after.txt");
  assert.equal((await registry.readFile("demo", "src/after.txt")).content, "content");
  await assert.rejects(registry.readFile("demo", "src/before.txt"), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "FILE_NOT_FOUND");

  await registry.movePath({ workspaceId: "demo", sourcePath: "src/new-dir", targetPath: "moved-dir" });
  await writeFile(path.join(root, "src", "keep.txt"), "keep", "utf8");
  await registry.deleteFile({ workspaceId: "demo", path: "src/after.txt" });
  await registry.deleteDirectory("demo", "moved-dir");
  await assert.rejects(registry.deleteDirectory("demo", "src"), (error: unknown) =>
    error instanceof WorkspaceFileError && error.code === "DIRECTORY_NOT_EMPTY");
});

test("mkdir_p creates missing parents idempotently and keeps sandbox boundaries", async () => {
  const { root, registry } = await makeRegistry();
  const first = await registry.createDirectories("demo", "a/b/c");
  assert.deepEqual(first.created, ["a", path.join("a", "b"), path.join("a", "b", "c")]);
  assert.equal((await registry.statFile("demo", "a/b/c")).kind, "directory");

  const second = await registry.createDirectories("demo", "a/b/c");
  assert.deepEqual(second.created, []);
  await writeFile(path.join(root, "a", "file.txt"), "x", "utf8");
  await assert.rejects(
    registry.createDirectories("demo", "a/file.txt/child"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "NOT_A_DIRECTORY",
  );
  await assert.rejects(registry.createDirectories("demo", "../escape/child"), PathSecurityError);
  await assert.rejects(registry.createDirectories("demo", "node_modules/child"), PathSecurityError);
});

test("copy_tree copies a bounded safe tree with include/exclude filters and no overwrite", async () => {
  const { root, registry } = await makeRegistry();
  await mkdir(path.join(root, "source"));
  await mkdir(path.join(root, "source", "nested"));
  await mkdir(path.join(root, "source", "skip"));
  await writeFile(path.join(root, "source", "root.txt"), "root", "utf8");
  await writeFile(path.join(root, "source", "nested", "keep.txt"), "keep", "utf8");
  await writeFile(path.join(root, "source", "nested", "ignore.bin"), "bin", "utf8");
  await writeFile(path.join(root, "source", "skip", "hidden.txt"), "hidden", "utf8");

  const result = await registry.copyTree("demo", "source", "copied", {
    include: ["**/*.txt"],
    exclude: ["skip/**"],
  });
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 8);
  assert.equal((await registry.readFile("demo", "copied/root.txt")).content, "root");
  assert.equal((await registry.readFile("demo", "copied/nested/keep.txt")).content, "keep");
  await assert.rejects(registry.readFile("demo", "copied/nested/ignore.bin"));
  await assert.rejects(registry.readFile("demo", "copied/skip/hidden.txt"));
  await assert.rejects(
    registry.copyTree("demo", "source", "copied"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "PATH_EXISTS",
  );
  await assert.rejects(
    registry.copyTree("demo", "source", "source/child-copy"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION",
  );
  await assert.rejects(
    registry.copyTree("demo", "source", "too-many-dirs", { maxDirectories: 2 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE",
  );
  await assert.rejects(
    registry.copyTree("demo", "source", "too-many-entries", { maxEntries: 3 }),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_TOO_LARGE",
  );
});

test("prepared file plan revalidates and executes mkdir/copy/move as a one-shot plan", async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "copy-source.txt"), "copy-me", "utf8");
  await writeFile(path.join(root, "move-source.txt"), "move-me", "utf8");
  const expectedHash = createHash("sha256").update("copy-me").digest("hex");

  const prepared = await registry.prepareFilePlan("demo", [
    { kind: "mkdir", path: "planned" },
    { kind: "mkdir", path: "planned/nested" },
    { kind: "copy", sourcePath: "copy-source.txt", targetPath: "planned/copy.txt", expectedHash },
    { kind: "move", sourcePath: "move-source.txt", targetPath: "planned/nested/moved.txt" },
  ]);
  assert.equal(prepared.operations, 4);
  assert.equal(prepared.mkdir, 2);
  assert.equal(prepared.copy, 1);
  assert.equal(prepared.move, 1);
  assert.equal(prepared.bytes, 14);

  const executed = await registry.executeFilePlan("demo", prepared.planId);
  assert.equal(executed.completed, true);
  assert.equal((await registry.readFile("demo", "planned/copy.txt")).content, "copy-me");
  assert.equal((await registry.readFile("demo", "planned/nested/moved.txt")).content, "move-me");
  assert.equal((await registry.readFile("demo", "copy-source.txt")).content, "copy-me");
  await assert.rejects(registry.readFile("demo", "move-source.txt"));
  await assert.rejects(
    registry.executeFilePlan("demo", prepared.planId),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "PLAN_NOT_FOUND",
  );
});

test("prepared file plan fails closed when source or target state changes", async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "source.txt"), "before", "utf8");
  const prepared = await registry.prepareFilePlan("demo", [
    { kind: "copy", sourcePath: "source.txt", targetPath: "target.txt" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, "source.txt"), "after-change", "utf8");

  await assert.rejects(
    registry.executeFilePlan("demo", prepared.planId),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "PLAN_STALE",
  );
  await assert.rejects(registry.readFile("demo", "target.txt"));

  const expectedHash = createHash("sha256").update("not-the-file").digest("hex");
  await assert.rejects(
    registry.prepareFilePlan("demo", [
      { kind: "copy", sourcePath: "source.txt", targetPath: "target2.txt", expectedHash },
    ]),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "CONTENT_MISMATCH",
  );
});

test("workspace mutation queue preserves dependent create then move ordering", async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "source.txt"), "queued", "utf8");

  await Promise.all([
    registry.createDirectory("demo", "archive"),
    registry.movePath("demo", "source.txt", "archive/source.txt"),
  ]);

  assert.equal((await registry.readFile("demo", "archive/source.txt")).content, "queued");
  await assert.rejects(
    registry.readFile("demo", "source.txt"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "FILE_NOT_FOUND",
  );
});

test("workspace move supports Windows case-only rename", { skip: process.platform !== "win32" }, async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "CaseName.txt"), "case", "utf8");
  await registry.movePath("demo", "CaseName.txt", "casename.txt");
  assert.equal((await registry.readFile("demo", "casename.txt")).content, "case");
});

test("workspace mutations reject existing targets, roots, non-empty directories, and blocked paths", async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "source.txt"), "source", "utf8");
  await writeFile(path.join(root, "target.txt"), "target", "utf8");
  await assert.rejects(
    registry.movePath("demo", "source.txt", "target.txt"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "PATH_EXISTS",
  );
  assert.equal((await registry.readFile("demo", "source.txt")).content, "source");
  assert.equal((await registry.readFile("demo", "target.txt")).content, "target");

  await mkdir(path.join(root, "tree"));
  await mkdir(path.join(root, "tree", "child"));
  await writeFile(path.join(root, "tree", "child", "file.txt"), "x", "utf8");
  await assert.rejects(
    registry.movePath("demo", "tree", "tree/child/moved"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION",
  );
  await assert.rejects(
    registry.deleteDirectory("demo", "tree"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "DIRECTORY_NOT_EMPTY",
  );
  await assert.rejects(
    registry.createDirectory("demo", "."),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION",
  );
  await assert.rejects(registry.createDirectory("demo", "../escape"), PathSecurityError);
  await assert.rejects(registry.deleteFile("demo", "../source.txt"), PathSecurityError);
  await assert.rejects(
    registry.deleteDirectory("demo", "."),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "INVALID_OPERATION",
  );
  await assert.rejects(
    registry.deleteFile("demo", "tree"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "NOT_A_FILE",
  );
  await assert.rejects(
    registry.deleteDirectory("demo", "source.txt"),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "NOT_A_DIRECTORY",
  );

  await assert.rejects(registry.createDirectory("demo", "node_modules"), PathSecurityError);
  await writeFile(path.join(root, ".env"), "secret", "utf8");
  await assert.rejects(registry.deleteFile("demo", ".env"), PathSecurityError);
  await mkdir(path.join(root, "dist"));
  await assert.rejects(registry.deleteDirectory("demo", "dist"), PathSecurityError);
  await assert.rejects(
    registry.movePath("demo", "source.txt", "dist/moved.txt"),
    (error: unknown) => error instanceof PathSecurityError && error.code === "SENSITIVE_PATH",
  );
});

test("workspace mutations reject symlinks and preserve the target boundary", async () => {
  const { root, registry } = await makeRegistry();
  const outside = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-mutation-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  } catch {
    // Symlink creation may require elevated privileges on Windows.
    return;
  }

  await assert.rejects(registry.deleteFile("demo", "link.txt"), PathSecurityError);
  await assert.rejects(registry.movePath("demo", "link.txt", "moved.txt"), PathSecurityError);
  await assert.rejects(registry.readFile("demo", "link.txt"), PathSecurityError);
});

test("trusted-dev inherits normal workspace mutation capabilities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-trusted-dev-files-"));
  await writeFile(path.join(root, "file.txt"), "before", "utf8");
  const registry = await WorkspaceRegistry.create({
    workspaces: [{ id: "trusted", root, mode: "trusted-dev" }],
    maxReadBytes: 1024,
  });

  await registry.writeFile("trusted", "created.txt", "created");
  await registry.applyPatch("trusted", "file.txt", {
    hunks: [{ oldText: "before", newText: "after" }],
  });
  await registry.createDirectory("trusted", "dir");
  await registry.movePath("trusted", "created.txt", "dir/moved.txt");

  assert.equal((await registry.readFile("trusted", "file.txt")).content, "after");
  assert.equal((await registry.readFile("trusted", "dir/moved.txt")).content, "created");
});

test("create, move, and delete are denied in readonly and handoff workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-mutation-modes-"));
  const readonlyRoot = path.join(base, "readonly");
  const handoffRoot = path.join(base, "handoff");
  await mkdir(readonlyRoot);
  await mkdir(handoffRoot);
  await writeFile(path.join(readonlyRoot, "file.txt"), "one", "utf8");
  await writeFile(path.join(handoffRoot, "file.txt"), "two", "utf8");
  await mkdir(path.join(readonlyRoot, "empty"));
  await mkdir(path.join(handoffRoot, "empty"));
  const registry = await WorkspaceRegistry.create({
    workspaces: [
      { id: "readonly", root: readonlyRoot, mode: "readonly" },
      { id: "handoff", root: handoffRoot, mode: "handoff" },
    ],
    maxReadBytes: 1024,
  });

  for (const workspaceId of ["readonly", "handoff"] as const) {
    const denied = (error: unknown) => error instanceof PathSecurityError && error.code === "PERMISSION_DENIED";
    await assert.rejects(registry.createDirectory(workspaceId, "new-dir"), denied);
    await assert.rejects(registry.movePath(workspaceId, "file.txt", "renamed.txt"), denied);
    await assert.rejects(registry.copyFile(workspaceId, "file.txt", "copied.txt"), denied);
    await assert.rejects(registry.deleteFile(workspaceId, "file.txt"), denied);
    await assert.rejects(registry.deleteDirectory(workspaceId, "empty"), denied);
  }
});

test("openWorkspace returns bounded AGENTS and CLAUDE context", async () => {
  const { root, registry } = await makeRegistry(32);
  await writeFile(path.join(root, "AGENTS.md"), "agent rules", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "claude rules", "utf8");
  await writeFile(path.join(root, "too-large.md"), "012345678901234567890123456789012345", "utf8");

  const workspace = await registry.openWorkspace("demo");
  assert.deepEqual(workspace.context?.map((item) => item.path), ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(workspace.context?.[0]?.content, "agent rules");
  assert.equal(workspace.context?.[1]?.bytes, 12);
  assert.equal(workspace.root.includes("too-large.md"), false);
});

test("exact-match and unified diff patches are atomic", async () => {
  const { root, registry } = await makeRegistry();
  await writeFile(path.join(root, "sample.txt"), "alpha\nbeta\n", "utf8");

  await registry.applyPatch("demo", "sample.txt", {
    hunks: [{ oldText: "beta", newText: "gamma" }],
  });
  assert.equal((await registry.readFile("demo", "sample.txt")).content, "alpha\ngamma\n");

  const unified = [
    "--- a/sample.txt",
    "+++ b/sample.txt",
    "@@ -1,2 +1,2 @@",
    " alpha",
    "-gamma",
    "+delta",
    "",
  ].join("\n");
  await registry.applyPatch({ workspaceId: "demo", path: "sample.txt", patch: unified });
  assert.equal((await registry.readFile("demo", "sample.txt")).content, "alpha\ndelta\n");

  const beforeFailure = (await registry.readFile("demo", "sample.txt")).content;
  await assert.rejects(
    registry.applyPatch("demo", "sample.txt", { hunks: [{ oldText: "not present", newText: "bad" }] }),
    PatchApplicationError,
  );
  assert.equal((await registry.readFile("demo", "sample.txt")).content, beforeFailure);
  await assert.rejects(
    registry.applyPatch("demo", "sample.txt", { hunks: [{ oldText: "a", newText: "bad" }] }),
    PatchApplicationError,
  );
  assert.equal((await registry.readFile("demo", "sample.txt")).content, beforeFailure);
});

test("patches and writes cannot modify readonly or handoff workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-mode-files-"));
  const readonlyRoot = path.join(base, "readonly");
  const handoffRoot = path.join(base, "handoff");
  await mkdir(readonlyRoot);
  await mkdir(handoffRoot);
  await writeFile(path.join(readonlyRoot, "file.txt"), "one", "utf8");
  await writeFile(path.join(handoffRoot, "file.txt"), "two", "utf8");
  const registry = await WorkspaceRegistry.create({
    workspaces: [
      { id: "readonly", root: readonlyRoot, mode: "readonly" },
      { id: "handoff", root: handoffRoot, mode: "handoff" },
    ],
    maxReadBytes: 1024,
  });

  await assert.rejects(registry.writeFile("readonly", "file.txt", "nope"), PathSecurityError);
  await assert.rejects(registry.writeFile("handoff", "file.txt", "nope"), PathSecurityError);
  await assert.rejects(
    registry.applyPatch("readonly", "file.txt", { hunks: [{ oldText: "one", newText: "nope" }] }),
    PathSecurityError,
  );
  await assert.rejects(
    registry.applyPatch("handoff", "file.txt", { hunks: [{ oldText: "two", newText: "nope" }] }),
    PathSecurityError,
  );
});
