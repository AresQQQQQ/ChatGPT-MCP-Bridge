import { createHash, randomUUID } from "node:crypto";
import { constants, type Dir, type Dirent, type Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, opendir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { isWorkspaceWritableMode, type WorkspaceConfig, type WorkspaceMode, type WorkspaceRecipeConfig } from "../config.js";
import {
  PathSandbox,
  PathSecurityError,
  validateWorkspaceRelativePath,
  type PathOperation,
  type ResolvedPath,
} from "../security/path-sandbox.js";

export class WorkspaceNotFoundError extends Error {
  public constructor(_workspaceId: string) {
    super("Unknown workspace");
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceUnavailableError extends Error {
  public constructor(_workspaceId: string) {
    super("Workspace is unavailable");
    this.name = "WorkspaceUnavailableError";
  }
}

export type WorkspaceFileErrorCode =
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "FILE_UNAVAILABLE"
  | "WRITE_FAILED"
  | "PATH_BUSY"
  | "PERMISSION_DENIED"
  | "CROSS_DEVICE"
  | "INSUFFICIENT_SPACE"
  | "OPERATION_NOT_SUPPORTED"
  | "PATH_EXISTS"
  | "DIRECTORY_NOT_EMPTY"
  | "INVALID_OPERATION"
  | "INVALID_SEARCH"
  | "INVALID_CURSOR"
  | "INVALID_GLOB"
  | "PLAN_NOT_FOUND"
  | "PLAN_STALE"
  | "PLAN_PARTIAL"
  | "COPY_TREE_PARTIAL"
  | "CONTENT_MISMATCH"
  | "SNAPSHOT_LIMIT";

const WORKSPACE_FILE_MESSAGES: Record<WorkspaceFileErrorCode, string> = {
  FILE_NOT_FOUND: "File not found",
  FILE_TOO_LARGE: "File exceeds the configured read limit",
  NOT_A_FILE: "Path is not a regular file",
  NOT_A_DIRECTORY: "Path is not a directory",
  FILE_UNAVAILABLE: "File operation failed",
  WRITE_FAILED: "File write failed",
  PATH_BUSY: "The path is busy or locked by another process",
  PERMISSION_DENIED: "Permission denied for the file operation",
  CROSS_DEVICE: "The file operation cannot cross filesystem boundaries",
  INSUFFICIENT_SPACE: "Insufficient space for the file operation",
  OPERATION_NOT_SUPPORTED: "The filesystem does not support this operation",
  PATH_EXISTS: "The target path already exists",
  DIRECTORY_NOT_EMPTY: "Directory is not empty",
  INVALID_OPERATION: "Invalid workspace file operation",
  INVALID_SEARCH: "Invalid search request",
  INVALID_CURSOR: "Invalid pagination cursor",
  INVALID_GLOB: "Invalid file glob pattern",
  PLAN_NOT_FOUND: "File plan was not found or has expired",
  PLAN_STALE: "File plan preconditions no longer match the workspace",
  PLAN_PARTIAL: "File plan failed and could not be fully rolled back",
  COPY_TREE_PARTIAL: "Tree copy failed after the target was created; the partial target was preserved for safe inspection",
  CONTENT_MISMATCH: "File content hash does not match the expected value",
  SNAPSHOT_LIMIT: "Tree snapshot exceeded its configured safety limit",
};

export class WorkspaceFileError extends Error {
  public constructor(public readonly code: WorkspaceFileErrorCode) {
    super(WORKSPACE_FILE_MESSAGES[code]);
    this.name = "WorkspaceFileError";
  }
}

export class PatchApplicationError extends Error {
  public constructor() {
    super("Patch could not be applied");
    this.name = "PatchApplicationError";
  }
}

export interface WorkspaceContextFile {
  readonly path: "AGENTS.md" | "CLAUDE.md";
  readonly content: string;
  readonly bytes: number;
}

export interface WorkspaceInfo {
  readonly workspaceId: string;
  readonly root: string;
  readonly mode: WorkspaceMode;
  readonly allowedScripts: readonly string[];
  readonly context?: readonly WorkspaceContextFile[];
}

export interface WorkspaceRecipeSummary {
  readonly recipeId: string;
  readonly description?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ReadFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly offset?: number;
  readonly nextOffset?: number;
  readonly totalBytes?: number;
  readonly eof?: boolean;
}

export interface ReadFileOptions {
  /** Zero-based byte offset. Use the returned nextOffset for the next page. */
  readonly offset?: number;
  /** Maximum bytes to read. It cannot exceed the workspace read limit. */
  readonly limit?: number;
}

export interface ReadBinaryFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly data: Buffer;
  readonly bytes: number;
}

export type DirectoryEntryKind = "file" | "directory";

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: DirectoryEntryKind;
  readonly size?: number;
}

export interface DirectoryListOptions {
  /** Opaque cursor returned by the previous page. */
  readonly cursor?: string;
  /** Maximum safe entries to return in one page. */
  readonly limit?: number;
}

export interface DirectoryPageResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface FileStatOptions {
  /** Hash regular files with SHA-256. Files over maxReadBytes are rejected when hashing is requested. */
  readonly includeHash?: boolean;
  /** Internal/request aggregate budget applied before hashing this individual file. */
  readonly maxHashBytes?: number;
}

export interface FileStatResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly kind: DirectoryEntryKind;
  readonly size?: number;
  readonly mtimeMs: number;
  readonly contentHash?: string;
}

export interface SearchOptions {
  readonly path?: string;
  readonly maxResults?: number;
  readonly maxDepth?: number;
  readonly includeContent?: boolean;
  readonly caseSensitive?: boolean;
  readonly maxFileBytes?: number;
  /** Opaque cursor returned by the previous search page. */
  readonly cursor?: string;
}

export interface SearchResult {
  readonly path: string;
  readonly kind: DirectoryEntryKind;
  readonly match: "name" | "content" | "name-and-content";
  readonly line?: number;
  readonly preview?: string;
}

export interface SearchPageResult {
  readonly workspaceId: string;
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface FindFilesOptions {
  readonly path?: string;
  readonly maxResults?: number;
  readonly maxDepth?: number;
  readonly caseSensitive?: boolean;
  /** Opaque cursor returned by the previous find page. */
  readonly cursor?: string;
}

export interface FindFileResult {
  readonly path: string;
  readonly size: number;
}

export interface FindFilesPageResult {
  readonly workspaceId: string;
  readonly pattern: string;
  readonly results: readonly FindFileResult[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface BatchReadFilesResult {
  readonly workspaceId: string;
  readonly files: readonly ReadFileResult[];
  readonly totalBytes: number;
}

export interface BatchStatFilesResult {
  readonly workspaceId: string;
  readonly files: readonly FileStatResult[];
}

export interface TreeSnapshotEntry {
  readonly path: string;
  readonly kind: DirectoryEntryKind;
  readonly size?: number;
  readonly contentHash?: string;
}

export interface TreeSnapshotOptions {
  readonly includeHash?: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFiles?: number;
  readonly maxDirectories?: number;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxTotalHashBytes?: number;
}

export interface TreeSnapshotResult {
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly path: string;
  readonly includeHash: boolean;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly hashedBytes: number;
  readonly expiresAt: number;
}

export interface TreeCompareResult {
  readonly workspaceId: string;
  readonly leftSnapshotId: string;
  readonly rightSnapshotId: string;
  readonly comparisonMode: "sha256" | "size";
  readonly identical: number;
  readonly changed: readonly string[];
  readonly missingLeft: readonly string[];
  readonly missingRight: readonly string[];
  readonly truncated: boolean;
}

export interface WriteFileRequest {
  readonly workspaceId: string;
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface WriteFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly bytes: number;
}

export interface WriteFileStreamResult extends WriteFileResult {
  readonly contentHash: string;
}

export interface CreateDirectoryRequest {
  readonly workspaceId: string;
  readonly path: string;
}

export interface CreateDirectoryResult {
  readonly workspaceId: string;
  readonly path: string;
}

export interface CreateDirectoriesResult extends CreateDirectoryResult {
  readonly created: readonly string[];
}

export interface MovePathRequest {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface MovePathResult {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CopyFileRequest {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CopyFileResult {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytes: number;
}

export interface CopyTreeOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFiles?: number;
  readonly maxDirectories?: number;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
}

export interface CopyTreeResult {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

export type FilePlanOperation =
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "copy" | "move"; readonly sourcePath: string; readonly targetPath: string; readonly expectedHash?: string };

export interface PreparedFilePlanResult {
  readonly workspaceId: string;
  readonly planId: string;
  readonly expiresAt: number;
  readonly operations: number;
  readonly mkdir: number;
  readonly copy: number;
  readonly move: number;
  readonly bytes: number;
}

export interface ExecuteFilePlanResult extends Omit<PreparedFilePlanResult, "expiresAt"> {
  readonly completed: true;
}

export interface DeletePathRequest {
  readonly workspaceId: string;
  readonly path: string;
}

export interface DeletePathResult {
  readonly workspaceId: string;
  readonly path: string;
}

export interface ExactMatchHunk {
  readonly oldText: string;
  readonly newText: string;
}

export interface ExactMatchPatch {
  readonly hunks: readonly ExactMatchHunk[];
}

export type PatchInput = string | ExactMatchPatch | readonly ExactMatchHunk[];

export interface ApplyPatchRequest {
  readonly workspaceId: string;
  readonly path: string;
  readonly patch: PatchInput;
}

interface StoredTreeSnapshot {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly includeHash: boolean;
  readonly entries: ReadonlyMap<string, TreeSnapshotEntry>;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly hashedBytes: number;
  readonly expiresAt: number;
}

interface StoredFilePlanSource {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentHash?: string;
}

interface StoredFilePlan {
  readonly workspaceId: string;
  readonly operations: readonly FilePlanOperation[];
  readonly sources: Readonly<Record<number, StoredFilePlanSource>>;
  readonly targetExists: Readonly<Record<number, boolean>>;
  readonly mkdirExists: Readonly<Record<number, boolean>>;
  readonly expiresAt: number;
  readonly summary: Omit<PreparedFilePlanResult, "workspaceId" | "planId" | "expiresAt">;
}

interface RegisteredWorkspace extends WorkspaceInfo {
  readonly sandbox: PathSandbox;
  readonly maxReadBytes: number;
  readonly recipes: Readonly<Record<string, WorkspaceRecipeConfig>>;
}

interface SearchQueueItem {
  readonly path: string;
  readonly depth: number;
}

interface OpenTraversalDirectory {
  readonly item: SearchQueueItem;
  readonly directory: Dir;
  readonly basePath: string;
}

interface DirectoryCursorState {
  readonly kind: "directory";
  readonly workspaceId: string;
  readonly path: string;
  readonly directory: Dir;
  readonly basePath: string;
}

interface SearchCursorState {
  readonly kind: "search";
  readonly workspaceId: string;
  readonly query: string;
  readonly path: string;
  readonly maxDepth: number;
  readonly includeContent: boolean;
  readonly caseSensitive: boolean;
  readonly maxFileBytes: number;
  readonly queue: SearchQueueItem[];
  current?: OpenTraversalDirectory;
}

interface FindFilesCursorState {
  readonly kind: "find-files";
  readonly workspaceId: string;
  readonly pattern: string;
  readonly path: string;
  readonly maxDepth: number;
  readonly caseSensitive: boolean;
  readonly queue: SearchQueueItem[];
  current?: OpenTraversalDirectory;
}

type CursorState = DirectoryCursorState | SearchCursorState | FindFilesCursorState;

interface StoredCursorState {
  readonly state: CursorState;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

const MAX_SEARCH_PREVIEW_CHARS = 500;
const DEFAULT_PAGE_SIZE = 100;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const FILE_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_FILE_PLANS = 64;
const TREE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_TREE_SNAPSHOTS = 32;
const MAX_ACTIVE_CURSORS = 256;

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_ENTRIES) {
    throw new WorkspaceFileError("INVALID_OPERATION");
  }
}

function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  if (!pattern || pattern.length > 1024 || pattern.includes("\0") || pattern.startsWith("/") || pattern.startsWith("\\")) {
    throw new WorkspaceFileError("INVALID_GLOB");
  }
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) throw new WorkspaceFileError("INVALID_GLOB");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  source += "$";
  return new RegExp(source, caseSensitive ? "u" : "iu");
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return buffer.length;
  const lead = buffer[leadIndex]!;
  const expectedLength = (lead & 0x80) === 0 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
      : (lead & 0xf0) === 0xe0 ? 3
        : (lead & 0xf8) === 0xf0 ? 4
          : 1;
  return buffer.length - leadIndex < expectedLength ? leadIndex : buffer.length;
}

function findContentPreview(content: string, query: string, caseSensitive: boolean): {
  line: number;
  preview: string;
} | undefined {
  const searchable = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matchIndex = searchable.indexOf(needle);
  if (matchIndex < 0) return undefined;

  const lineStart = content.lastIndexOf("\n", matchIndex - 1) + 1;
  const lineEndIndex = content.indexOf("\n", matchIndex);
  const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex;
  const rawLine = content.slice(lineStart, lineEnd).replace(/\r$/u, "");
  const relativeMatch = Math.max(0, matchIndex - lineStart);
  const previewStart = Math.max(0, relativeMatch - Math.floor(MAX_SEARCH_PREVIEW_CHARS / 2));
  const preview = rawLine.slice(previewStart, previewStart + MAX_SEARCH_PREVIEW_CHARS);
  const line = content.slice(0, lineStart).split("\n").length;
  return { line, preview };
}

export const MAX_DIRECTORY_ENTRIES = 2_000;
export const MAX_BINARY_READ_BYTES = 50 * 1024 * 1024;

interface UnifiedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isStrictlyInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mutationError(error: unknown, fallback: WorkspaceFileErrorCode = "WRITE_FAILED"): WorkspaceFileError {
  if (error instanceof WorkspaceFileError) return error;
  if (isNodeError(error)) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return new WorkspaceFileError("PATH_EXISTS");
    if (error.code === "ENOENT") return new WorkspaceFileError("FILE_NOT_FOUND");
    if (error.code === "ENOTDIR") return new WorkspaceFileError("NOT_A_DIRECTORY");
    if (error.code === "EISDIR") return new WorkspaceFileError("NOT_A_FILE");
    if (error.code === "EBUSY" || error.code === "ETXTBSY") return new WorkspaceFileError("PATH_BUSY");
    if (error.code === "EACCES" || error.code === "EPERM") return new WorkspaceFileError("PERMISSION_DENIED");
    if (error.code === "EXDEV") return new WorkspaceFileError("CROSS_DEVICE");
    if (error.code === "ENOSPC" || error.code === "EDQUOT") return new WorkspaceFileError("INSUFFICIENT_SPACE");
    if (error.code === "ENOTSUP" || error.code === "EOPNOTSUPP") return new WorkspaceFileError("OPERATION_NOT_SUPPORTED");
  }
  return new WorkspaceFileError(fallback);
}

function workspacePathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function sameStableFileState(expected: Stats, actual: Stats): boolean {
  return expected.isFile() && actual.isFile()
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  return expected.isFile() && actual.isFile()
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs;
}

async function copyStableFileToNewTarget(sourcePath: string, targetPath: string, expected: Stats): Promise<void> {
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceLeaf = await lstat(sourcePath);
    if (sourceLeaf.isSymbolicLink()) throw new PathSecurityError("SYMLINK_DISALLOWED");
    sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollowFlag());
    const before = await sourceHandle.stat();
    if (!sameStableFileState(expected, before)) throw new WorkspaceFileError("FILE_UNAVAILABLE");

    targetHandle = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const targetIdentity = await targetHandle.stat();
    if (!targetIdentity.isFile()) throw new WorkspaceFileError("WRITE_FAILED");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new WorkspaceFileError("FILE_UNAVAILABLE");
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new WorkspaceFileError("WRITE_FAILED");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }

    const after = await sourceHandle.stat();
    if (!sameStableFileState(before, after) || !sameStableFileState(expected, after)) {
      throw new WorkspaceFileError("FILE_UNAVAILABLE");
    }
    await targetHandle.sync();
    const completedIdentity = await targetHandle.stat();
    if (!sameFileIdentity(targetIdentity, completedIdentity) || completedIdentity.size !== before.size) {
      throw new WorkspaceFileError("WRITE_FAILED");
    }
  } catch (error) {
    if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
    throw mutationError(error);
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
  }
  return Buffer.concat(chunks, total);
}

function normalizePatchPath(value: string): string | undefined {
  const raw = value.trim().split(/[\t ]/u, 1)[0] ?? "";
  if (raw === "/dev/null") return undefined;
  if (!raw || raw.startsWith("/") || raw.startsWith("\\") || raw.split(/[\\/]/u).includes("..")) {
    throw new PatchApplicationError();
  }
  const withoutPrefix = raw.replace(/^(?:a|b)[\\/]/u, "");
  return withoutPrefix.replaceAll("\\", "/");
}

function assertPatchHeaderMatches(headerPath: string | undefined, relativePath: string): void {
  if (!headerPath) return;
  const target = relativePath.replaceAll("\\", "/");
  if (headerPath !== target) throw new PatchApplicationError();
}

function parseUnifiedPatch(patch: string, relativePath: string): readonly UnifiedHunk[] {
  if (!patch || typeof patch !== "string") throw new PatchApplicationError();
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  let sourceHeader: string | undefined;
  let targetHeader: string | undefined;

  if (lines[index]?.startsWith("--- ")) {
    sourceHeader = normalizePatchPath(lines[index]?.slice(4) ?? "");
    index += 1;
    if (!lines[index]?.startsWith("+++ ")) throw new PatchApplicationError();
    targetHeader = normalizePatchPath(lines[index]?.slice(4) ?? "");
    index += 1;
  }
  assertPatchHeaderMatches(sourceHeader, relativePath);
  assertPatchHeaderMatches(targetHeader, relativePath);

  const hunks: UnifiedHunk[] = [];
  while (index < lines.length) {
    if (index === lines.length - 1 && lines[index] === "") break;
    const header = lines[index] ?? "";
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
    if (!match) throw new PatchApplicationError();
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    index += 1;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("@@ ")) break;
      if (line === "\\ No newline at end of file") {
        index += 1;
        continue;
      }
      if (index === lines.length - 1 && line === "") break;
      const marker = line[0];
      if (marker !== " " && marker !== "-" && marker !== "+") {
        throw new PatchApplicationError();
      }
      const text = line.slice(1);
      if (marker !== "+") oldLines.push(text);
      if (marker !== "-") newLines.push(text);
      index += 1;
    }
    if (oldLines.length !== oldCount || newLines.length !== newCount) {
      throw new PatchApplicationError();
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, oldLines, newLines });
  }
  if (hunks.length === 0) throw new PatchApplicationError();
  return hunks;
}

function splitSourceLines(source: string): { lines: string[]; newline: "\n" | "\r\n"; trailingNewline: boolean } {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = source.endsWith(newline);
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, newline, trailingNewline };
}

function applyUnifiedPatch(source: string, patch: string, relativePath: string): string {
  const hunks = parseUnifiedPatch(patch, relativePath);
  const sourceLines = splitSourceLines(source);
  const lines = [...sourceLines.lines];
  let offset = 0;

  for (const hunk of hunks) {
    const insertion = hunk.oldCount === 0;
    const baseIndex = insertion
      ? (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1)
      : hunk.oldStart - 1;
    const index = baseIndex + offset;
    if (index < 0 || index > lines.length) throw new PatchApplicationError();
    const actual = lines.slice(index, index + hunk.oldCount);
    if (actual.length !== hunk.oldLines.length || actual.some((line, lineIndex) => line !== hunk.oldLines[lineIndex])) {
      throw new PatchApplicationError();
    }
    lines.splice(index, hunk.oldCount, ...hunk.newLines);
    offset += hunk.newCount - hunk.oldCount;
  }

  const result = lines.join(sourceLines.newline);
  return sourceLines.trailingNewline ? `${result}${sourceLines.newline}` : result;
}

function applyExactPatch(source: string, patch: ExactMatchPatch | readonly ExactMatchHunk[]): string {
  if (!patch || typeof patch !== "object") throw new PatchApplicationError();
  const hunks = "hunks" in patch ? patch.hunks : patch;
  if (!Array.isArray(hunks) || hunks.length === 0) throw new PatchApplicationError();
  let result = source;
  for (const hunk of hunks) {
    if (!hunk || typeof hunk.oldText !== "string" || typeof hunk.newText !== "string" || hunk.oldText.length === 0) {
      throw new PatchApplicationError();
    }
    const first = result.indexOf(hunk.oldText);
    if (first < 0 || result.indexOf(hunk.oldText, first + hunk.oldText.length) >= 0) {
      throw new PatchApplicationError();
    }
    result = `${result.slice(0, first)}${hunk.newText}${result.slice(first + hunk.oldText.length)}`;
  }
  return result;
}

function applyPatchText(source: string, patch: PatchInput, relativePath: string): string {
  if (typeof patch === "string") return applyUnifiedPatch(source, patch, relativePath);
  return applyExactPatch(source, patch);
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, RegisteredWorkspace>();
  private readonly traversalCursors = new Map<string, StoredCursorState>();
  private readonly filePlans = new Map<string, StoredFilePlan>();
  private readonly treeSnapshots = new Map<string, StoredTreeSnapshot>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  private constructor() {}

  public static async create(config: { workspaces: readonly WorkspaceConfig[]; maxReadBytes: number }): Promise<WorkspaceRegistry> {
    if (!Number.isSafeInteger(config.maxReadBytes) || config.maxReadBytes <= 0) {
      throw new Error("Invalid read limit");
    }
    const registry = new WorkspaceRegistry();
    for (const workspace of config.workspaces) {
      if (registry.workspaces.has(workspace.id)) {
        throw new WorkspaceUnavailableError(workspace.id);
      }
      try {
        const mode = workspace.mode ?? "workspace";
        const sandbox = await PathSandbox.create([{
          id: workspace.id,
          path: workspace.root,
          mode,
        }], { symlinkPolicy: "deny" });
        const root = sandbox.getRoot(workspace.id);
        registry.workspaces.set(workspace.id, {
          workspaceId: workspace.id,
          root: root.path,
          mode: root.mode,
          allowedScripts: workspace.allowedScripts ?? ["test", "build", "lint", "typecheck"],
          recipes: workspace.recipes ?? {},
          sandbox,
          maxReadBytes: config.maxReadBytes,
        });
      } catch {
        throw new WorkspaceUnavailableError(workspace.id);
      }
    }
    return registry;
  }

  public listRecipes(workspaceId: string): readonly WorkspaceRecipeSummary[] {
    const workspace = this.requireWorkspace(workspaceId);
    return Object.entries(workspace.recipes).map(([recipeId, recipe]) => ({
      recipeId,
      ...(recipe.description ? { description: recipe.description } : {}),
      ...(recipe.cwd ? { cwd: recipe.cwd } : {}),
      ...(recipe.timeoutMs !== undefined ? { timeoutMs: recipe.timeoutMs } : {}),
    }));
  }

  public getRecipe(workspaceId: string, recipeId: string): WorkspaceRecipeConfig {
    const workspace = this.requireWorkspace(workspaceId);
    const recipe = workspace.recipes[recipeId];
    if (!recipe) throw new WorkspaceFileError("INVALID_OPERATION");
    return {
      ...(recipe.description ? { description: recipe.description } : {}),
      executable: recipe.executable,
      args: [...recipe.args],
      ...(recipe.cwd ? { cwd: recipe.cwd } : {}),
      ...(recipe.timeoutMs !== undefined ? { timeoutMs: recipe.timeoutMs } : {}),
    };
  }

  public async openWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      await workspace.sandbox.resolve({
        rootId: workspaceId,
        relativePath: ".",
        operation: "list",
      });
    } catch {
      throw new WorkspaceUnavailableError(workspaceId);
    }

    const context: WorkspaceContextFile[] = [];
    for (const contextPath of ["AGENTS.md", "CLAUDE.md"] as const) {
      try {
        const result = await this.readFile(workspaceId, contextPath);
        context.push({ path: contextPath, content: result.content, bytes: result.bytes });
      } catch (error) {
        // Context is optional. A missing, blocked, oversized, or concurrently
        // unavailable context file must never weaken the workspace boundary.
        if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) continue;
        throw new WorkspaceUnavailableError(workspaceId);
      }
    }
    return {
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      mode: workspace.mode,
      allowedScripts: workspace.allowedScripts,
      context,
    };
  }

  public async readFile(
    workspaceId: string,
    relativePath: string,
    options: ReadFileOptions = {},
  ): Promise<ReadFileResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const paged = options.offset !== undefined || options.limit !== undefined;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? workspace.maxReadBytes;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > workspace.maxReadBytes
    ) throw new WorkspaceFileError("INVALID_OPERATION");
    const resolved = await this.resolveExisting(workspace, relativePath, "read");
    const filePath = resolved.lexicalPath;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new WorkspaceFileError("NOT_A_FILE");
      if (!paged && metadata.size > workspace.maxReadBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
      let buffer: Buffer;
      if (paged) {
        const requestedBytes = Math.min(limit, Math.max(0, metadata.size - offset));
        const page = Buffer.allocUnsafe(requestedBytes);
        const { bytesRead } = requestedBytes === 0
          ? { bytesRead: 0 }
          : await handle.read(page, 0, requestedBytes, offset);
        const bytes = page.subarray(0, bytesRead);
        const completeBytes = offset + bytesRead < metadata.size ? completeUtf8PrefixLength(bytes) : bytes.length;
        buffer = bytes.subarray(0, completeBytes);
      } else {
        buffer = await readBounded(handle, workspace.maxReadBytes);
      }
      return {
        workspaceId,
        path: relativePath,
        content: buffer.toString("utf8"),
        bytes: buffer.byteLength,
        ...(paged ? {
          offset,
          nextOffset: offset + buffer.byteLength,
          totalBytes: metadata.size,
          eof: offset + buffer.byteLength >= metadata.size,
        } : {}),
      };
    } catch (error) {
      if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") throw new WorkspaceFileError("FILE_NOT_FOUND");
      if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENXIO")) {
        throw new PathSecurityError("SYMLINK_DISALLOWED");
      }
      throw new WorkspaceFileError("FILE_UNAVAILABLE");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async readBinaryFile(
    workspaceId: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<ReadBinaryFileResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BINARY_READ_BYTES) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    const workspace = this.requireWorkspace(workspaceId);
    const resolved = await this.resolveExisting(workspace, relativePath, "read");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(resolved.lexicalPath, constants.O_RDONLY | noFollowFlag());
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new WorkspaceFileError("NOT_A_FILE");
      if (metadata.size > maxBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
      const data = await readBounded(handle, maxBytes);
      return { workspaceId, path: relativePath, data, bytes: data.byteLength };
    } catch (error) {
      if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") throw new WorkspaceFileError("FILE_NOT_FOUND");
      if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENXIO")) {
        throw new PathSecurityError("SYMLINK_DISALLOWED");
      }
      throw new WorkspaceFileError("FILE_UNAVAILABLE");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async listDirectory(workspaceId: string, relativePath = "."): Promise<readonly DirectoryEntry[]> {
    const page = await this.listDirectoryPage(workspaceId, relativePath, { limit: MAX_DIRECTORY_ENTRIES });
    if (page.nextCursor) {
      const state = await this.takeCursor(page.nextCursor, "directory");
      await state.directory.close().catch(() => undefined);
    }
    return page.entries;
  }

  public async listDirectoryPage(
    workspaceId: string,
    relativePath = ".",
    options: DirectoryListOptions = {},
  ): Promise<DirectoryPageResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    assertPageLimit(limit);
    await this.pruneExpiredCursors();

    let state: DirectoryCursorState;
    let cursorId = options.cursor;
    if (cursorId) {
      const stored = await this.takeCursor(cursorId, "directory");
      if (stored.workspaceId !== workspaceId || stored.path !== relativePath) {
        await stored.directory.close().catch(() => undefined);
        throw new WorkspaceFileError("INVALID_CURSOR");
      }
      state = stored;
      cursorId = undefined;
    } else {
      const resolved = await this.resolveExisting(workspace, relativePath, "list");
      const directoryPath = resolved.canonicalPath ?? resolved.lexicalPath;
      const metadata = await stat(directoryPath).catch(() => undefined);
      if (!metadata) throw new WorkspaceFileError("FILE_UNAVAILABLE");
      if (!metadata.isDirectory()) throw new WorkspaceFileError("NOT_A_DIRECTORY");
      const directory = await opendir(directoryPath).catch(() => undefined);
      if (!directory) throw new WorkspaceFileError("FILE_UNAVAILABLE");
      state = {
        kind: "directory",
        workspaceId,
        path: relativePath,
        directory,
        basePath: relativePath === "." ? "" : relativePath,
      };
    }

    const entries: DirectoryEntry[] = [];
    try {
      while (entries.length < limit) {
        const entry = await state.directory.read();
        if (!entry) {
          await state.directory.close().catch(() => undefined);
          return { workspaceId, path: relativePath, entries, truncated: false };
        }
        const safeEntry = await this.resolveDirectoryEntry(workspace, workspaceId, state.basePath, entry);
        if (safeEntry) entries.push(safeEntry);
      }
      const nextCursor = await this.storeCursor(state);
      return { workspaceId, path: relativePath, entries, truncated: true, nextCursor };
    } catch (error) {
      await state.directory.close().catch(() => undefined);
      throw error;
    }
  }

  public async statFile(
    workspaceId: string,
    relativePath: string,
    options: FileStatOptions = {},
  ): Promise<FileStatResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const resolved = await this.resolveExisting(workspace, relativePath, "read");
    const metadata = await stat(resolved.canonicalPath ?? resolved.lexicalPath).catch(() => undefined);
    if (!metadata) throw new WorkspaceFileError("FILE_UNAVAILABLE");
    const kind: DirectoryEntryKind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : (() => { throw new WorkspaceFileError("INVALID_OPERATION"); })();
    let contentHash: string | undefined;
    let stableMetadata = metadata;
    if (options.includeHash) {
      if (kind !== "file") throw new WorkspaceFileError("NOT_A_FILE");
      const maxHashBytes = Math.min(workspace.maxReadBytes, options.maxHashBytes ?? workspace.maxReadBytes);
      if (!Number.isSafeInteger(maxHashBytes) || maxHashBytes < 1) throw new WorkspaceFileError("FILE_TOO_LARGE");
      if (metadata.size > maxHashBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const leaf = await lstat(resolved.lexicalPath);
        if (leaf.isSymbolicLink()) throw new PathSecurityError("SYMLINK_DISALLOWED");
        handle = await open(resolved.lexicalPath, constants.O_RDONLY | noFollowFlag());
        const before = await handle.stat();
        if (!before.isFile()) throw new WorkspaceFileError("NOT_A_FILE");
        if (before.size > maxHashBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
        if (!sameStableFileState(metadata, before)) throw new WorkspaceFileError("FILE_UNAVAILABLE");
        const bytes = await readBounded(handle, workspace.maxReadBytes);
        const after = await handle.stat();
        if (!sameStableFileState(before, after)) throw new WorkspaceFileError("FILE_UNAVAILABLE");
        stableMetadata = after;
        contentHash = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
        if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENXIO")) {
          throw new PathSecurityError("SYMLINK_DISALLOWED");
        }
        throw new WorkspaceFileError("FILE_UNAVAILABLE");
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    return {
      workspaceId,
      path: relativePath,
      kind,
      ...(kind === "file" ? { size: stableMetadata.size } : {}),
      mtimeMs: stableMetadata.mtimeMs,
      ...(contentHash ? { contentHash } : {}),
    };
  }

  public async statFiles(
    workspaceId: string,
    paths: readonly string[],
    options: FileStatOptions & { readonly maxTotalHashBytes?: number } = {},
  ): Promise<BatchStatFilesResult> {
    if (paths.length < 1 || paths.length > 100) throw new WorkspaceFileError("INVALID_OPERATION");
    const maxTotalHashBytes = options.maxTotalHashBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxTotalHashBytes) || maxTotalHashBytes < 1 || maxTotalHashBytes > 512 * 1024 * 1024) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    const files: FileStatResult[] = [];
    let hashedBytes = 0;
    for (const relativePath of paths) {
      if (options.includeHash) {
        const remaining = maxTotalHashBytes - hashedBytes;
        if (remaining < 1) throw new WorkspaceFileError("FILE_TOO_LARGE");
        const file = await this.statFile(workspaceId, relativePath, { includeHash: true, maxHashBytes: remaining });
        hashedBytes += file.size ?? 0;
        files.push(file);
      } else {
        files.push(await this.statFile(workspaceId, relativePath));
      }
    }
    return { workspaceId, files };
  }

  public async readFiles(
    workspaceId: string,
    paths: readonly string[],
    maxTotalBytes = 2 * 1024 * 1024,
  ): Promise<BatchReadFilesResult> {
    if (paths.length < 1 || paths.length > 20) throw new WorkspaceFileError("INVALID_OPERATION");
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 8 * 1024 * 1024) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    const files: ReadFileResult[] = [];
    let totalBytes = 0;
    for (const relativePath of paths) {
      const file = await this.readFile(workspaceId, relativePath);
      totalBytes += file.bytes;
      if (totalBytes > maxTotalBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
      files.push(file);
    }
    return { workspaceId, files, totalBytes };
  }

  public async snapshotTree(
    workspaceId: string,
    relativePath = ".",
    options: TreeSnapshotOptions = {},
  ): Promise<TreeSnapshotResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const includeHash = options.includeHash ?? false;
    const include = options.include ?? [];
    const exclude = options.exclude ?? [];
    const maxFiles = options.maxFiles ?? 2_000;
    const maxDirectories = options.maxDirectories ?? 2_000;
    const maxEntries = options.maxEntries ?? 4_000;
    const maxDepth = options.maxDepth ?? 32;
    const maxTotalHashBytes = options.maxTotalHashBytes ?? 256 * 1024 * 1024;
    if (include.length > 32 || exclude.length > 32) throw new WorkspaceFileError("INVALID_GLOB");
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
    if (!Number.isSafeInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > 10_000) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
    if (!Number.isSafeInteger(maxTotalHashBytes) || maxTotalHashBytes < 1 || maxTotalHashBytes > 1024 * 1024 * 1024) {
      throw new WorkspaceFileError("SNAPSHOT_LIMIT");
    }

    const includeMatchers = include.length > 0 ? include.map((pattern) => globToRegExp(pattern, true)) : [];
    const excludeMatchers = exclude.map((pattern) => globToRegExp(pattern, true));
    const normalizeRelative = (value: string): string => value.replaceAll("\\", "/");
    const isExcluded = (relative: string, directory = false): boolean => {
      const normalized = normalizeRelative(relative);
      return excludeMatchers.some((matcher) => matcher.test(normalized) || (directory && matcher.test(`${normalized}/_`)));
    };
    const isIncluded = (relative: string): boolean => {
      if (includeMatchers.length === 0) return true;
      const normalized = normalizeRelative(relative);
      return includeMatchers.some((matcher) => matcher.test(normalized));
    };

    const root = await this.resolveExisting(workspace, relativePath, "list");
    if (root.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
    const rootAbsolute = root.canonicalPath ?? root.lexicalPath;
    const queue: Array<{ relative: string; absolute: string; depth: number }> = [{ relative: "", absolute: rootAbsolute, depth: 0 }];
    const entries = new Map<string, TreeSnapshotEntry>();
    let fileCount = 0;
    let directoryCount = 1;
    let totalBytes = 0;
    let hashedBytes = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const directory = await opendir(current.absolute).catch(() => undefined);
      if (!directory) throw new WorkspaceFileError("FILE_UNAVAILABLE");
      try {
        for await (const entry of directory) {
          const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
          const normalized = normalizeRelative(relative);
          if (entry.isSymbolicLink()) throw new PathSecurityError("SYMLINK_DISALLOWED");
          if (entry.isDirectory() && isExcluded(relative, true)) continue;
          if (!entry.isDirectory() && isExcluded(relative, false)) continue;

          const fullRelative = relativePath === "." ? relative : path.join(relativePath, relative);
          const resolved = await workspace.sandbox.resolve({
            rootId: workspaceId,
            relativePath: fullRelative,
            operation: entry.isDirectory() ? "list" : "read",
          });
          const canonical = resolved.canonicalPath ?? resolved.lexicalPath;
          if (entry.isDirectory()) {
            if (resolved.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
            if (current.depth >= maxDepth) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
            directoryCount += 1;
            if (directoryCount > maxDirectories || fileCount + directoryCount > maxEntries) {
              throw new WorkspaceFileError("SNAPSHOT_LIMIT");
            }
            entries.set(normalized, { path: normalized, kind: "directory" });
            queue.push({ relative, absolute: canonical, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile() || resolved.kind !== "file") throw new WorkspaceFileError("INVALID_OPERATION");
          if (!isIncluded(relative)) continue;
          const metadata = await stat(canonical).catch(() => undefined);
          if (!metadata?.isFile()) throw new WorkspaceFileError("FILE_UNAVAILABLE");
          fileCount += 1;
          totalBytes += metadata.size;
          if (fileCount > maxFiles || fileCount + directoryCount > maxEntries) {
            throw new WorkspaceFileError("SNAPSHOT_LIMIT");
          }

          let contentHash: string | undefined;
          if (includeHash) {
            if (hashedBytes + metadata.size > maxTotalHashBytes) throw new WorkspaceFileError("SNAPSHOT_LIMIT");
            contentHash = await this.hashStableFile(resolved.lexicalPath, metadata);
            hashedBytes += metadata.size;
          }
          entries.set(normalized, {
            path: normalized,
            kind: "file",
            size: metadata.size,
            ...(contentHash ? { contentHash } : {}),
          });
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    }

    this.pruneExpiredTreeSnapshots();
    while (this.treeSnapshots.size >= MAX_ACTIVE_TREE_SNAPSHOTS) {
      const oldest = this.treeSnapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.treeSnapshots.delete(oldest);
    }
    const snapshotId = randomUUID();
    const expiresAt = Date.now() + TREE_SNAPSHOT_TTL_MS;
    this.treeSnapshots.set(snapshotId, {
      workspaceId,
      rootPath: relativePath,
      includeHash,
      entries,
      files: fileCount,
      directories: directoryCount,
      bytes: totalBytes,
      hashedBytes,
      expiresAt,
    });
    return {
      workspaceId,
      snapshotId,
      path: relativePath,
      includeHash,
      files: fileCount,
      directories: directoryCount,
      bytes: totalBytes,
      hashedBytes,
      expiresAt,
    };
  }

  public compareTreeSnapshots(
    workspaceId: string,
    leftSnapshotId: string,
    rightSnapshotId: string,
    maxDifferences = 500,
  ): TreeCompareResult {
    if (!Number.isSafeInteger(maxDifferences) || maxDifferences < 1 || maxDifferences > 2_000) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    this.pruneExpiredTreeSnapshots();
    const left = this.treeSnapshots.get(leftSnapshotId);
    const right = this.treeSnapshots.get(rightSnapshotId);
    if (!left || !right || left.workspaceId !== workspaceId || right.workspaceId !== workspaceId) {
      throw new WorkspaceFileError("PLAN_NOT_FOUND");
    }

    const comparisonMode: "sha256" | "size" = left.includeHash && right.includeHash ? "sha256" : "size";
    const changed: string[] = [];
    const missingLeft: string[] = [];
    const missingRight: string[] = [];
    let identical = 0;
    let totalDifferences = 0;
    const keys = new Set<string>([...left.entries.keys(), ...right.entries.keys()]);
    for (const key of [...keys].sort()) {
      const leftEntry = left.entries.get(key);
      const rightEntry = right.entries.get(key);
      if (!leftEntry) {
        totalDifferences += 1;
        if (totalDifferences <= maxDifferences) missingLeft.push(key);
        continue;
      }
      if (!rightEntry) {
        totalDifferences += 1;
        if (totalDifferences <= maxDifferences) missingRight.push(key);
        continue;
      }
      let same = leftEntry.kind === rightEntry.kind;
      if (same && leftEntry.kind === "file" && rightEntry.kind === "file") {
        same = comparisonMode === "sha256"
          ? leftEntry.contentHash !== undefined && leftEntry.contentHash === rightEntry.contentHash
          : leftEntry.size === rightEntry.size;
      }
      if (same) identical += 1;
      else {
        totalDifferences += 1;
        if (totalDifferences <= maxDifferences) changed.push(key);
      }
    }
    return {
      workspaceId,
      leftSnapshotId,
      rightSnapshotId,
      comparisonMode,
      identical,
      changed,
      missingLeft,
      missingRight,
      truncated: totalDifferences > maxDifferences,
    };
  }

  public async search(workspaceId: string, query: string, options: SearchOptions = {}): Promise<SearchPageResult> {
    if (typeof query !== "string" || query.length === 0 || query.length > 1024) {
      throw new WorkspaceFileError("INVALID_SEARCH");
    }
    const workspace = this.requireWorkspace(workspaceId);
    const maxResults = options.maxResults ?? 100;
    const maxDepth = options.maxDepth ?? 32;
    if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > 500 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
      throw new WorkspaceFileError("INVALID_SEARCH");
    }
    const includeContent = options.includeContent ?? true;
    const caseSensitive = options.caseSensitive ?? false;
    const maxFileBytes = options.maxFileBytes ?? Math.min(workspace.maxReadBytes, 512 * 1024);
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new WorkspaceFileError("INVALID_SEARCH");
    const rootPath = options.path ?? ".";
    await this.pruneExpiredCursors();

    let state: SearchCursorState;
    if (options.cursor) {
      state = await this.takeCursor(options.cursor, "search");
      if (
        state.workspaceId !== workspaceId || state.query !== query || state.path !== rootPath ||
        state.maxDepth !== maxDepth || state.includeContent !== includeContent ||
        state.caseSensitive !== caseSensitive || state.maxFileBytes !== maxFileBytes
      ) {
        await this.closeCursorState(state);
        throw new WorkspaceFileError("INVALID_CURSOR");
      }
    } else {
      state = {
        kind: "search",
        workspaceId,
        query,
        path: rootPath,
        maxDepth,
        includeContent,
        caseSensitive,
        maxFileBytes,
        queue: [{ path: rootPath, depth: 0 }],
      };
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: SearchResult[] = [];
    try {
      while (results.length < maxResults) {
        if (!state.current) {
          const item = state.queue.shift();
          if (!item) break;
          state.current = await this.openTraversalDirectory(workspace, workspaceId, item);
        }
        const entry = await state.current.directory.read();
        if (!entry) {
          await state.current.directory.close().catch(() => undefined);
          delete state.current;
          continue;
        }
        const safeEntry = await this.resolveDirectoryEntry(workspace, workspaceId, state.current.basePath, entry);
        if (!safeEntry) continue;
        const nameMatches = caseSensitive
          ? safeEntry.name.includes(query)
          : safeEntry.name.toLowerCase().includes(needle);
        if (safeEntry.kind === "directory") {
          if (state.current.item.depth < maxDepth) {
            state.queue.push({ path: safeEntry.path, depth: state.current.item.depth + 1 });
          }
          if (nameMatches) results.push({ path: safeEntry.path, kind: "directory", match: "name" });
          continue;
        }
        let contentPreview: ReturnType<typeof findContentPreview>;
        if (includeContent && (safeEntry.size ?? Number.MAX_SAFE_INTEGER) <= maxFileBytes) {
          try {
            const content = await this.readFile(workspaceId, safeEntry.path);
            contentPreview = findContentPreview(content.content, query, caseSensitive);
          } catch (error) {
            if (!(error instanceof WorkspaceFileError) && !(error instanceof PathSecurityError)) throw error;
          }
        }
        const contentMatches = contentPreview !== undefined;
        if (nameMatches || contentMatches) {
          results.push({
            path: safeEntry.path,
            kind: "file",
            match: nameMatches && contentMatches ? "name-and-content" : nameMatches ? "name" : "content",
            ...(contentPreview ? { line: contentPreview.line, preview: contentPreview.preview } : {}),
          });
        }
      }
      const truncated = state.current !== undefined || state.queue.length > 0;
      const nextCursor = truncated ? await this.storeCursor(state) : undefined;
      return { workspaceId, query, results, truncated, ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) {
      await this.closeCursorState(state);
      throw error;
    }
  }

  public async findFiles(workspaceId: string, pattern: string, options: FindFilesOptions = {}): Promise<FindFilesPageResult> {
    const maxResults = options.maxResults ?? 100;
    const maxDepth = options.maxDepth ?? 32;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 500 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
      throw new WorkspaceFileError("INVALID_GLOB");
    }
    const workspace = this.requireWorkspace(workspaceId);
    const caseSensitive = options.caseSensitive ?? false;
    const rootPath = options.path ?? ".";
    const matcher = globToRegExp(pattern, caseSensitive);
    await this.pruneExpiredCursors();

    let state: FindFilesCursorState;
    if (options.cursor) {
      state = await this.takeCursor(options.cursor, "find-files");
      if (
        state.workspaceId !== workspaceId || state.pattern !== pattern || state.path !== rootPath ||
        state.maxDepth !== maxDepth || state.caseSensitive !== caseSensitive
      ) {
        await this.closeCursorState(state);
        throw new WorkspaceFileError("INVALID_CURSOR");
      }
    } else {
      state = {
        kind: "find-files",
        workspaceId,
        pattern,
        path: rootPath,
        maxDepth,
        caseSensitive,
        queue: [{ path: rootPath, depth: 0 }],
      };
    }

    const results: FindFileResult[] = [];
    try {
      while (results.length < maxResults) {
        if (!state.current) {
          const item = state.queue.shift();
          if (!item) break;
          state.current = await this.openTraversalDirectory(workspace, workspaceId, item);
        }
        const entry = await state.current.directory.read();
        if (!entry) {
          await state.current.directory.close().catch(() => undefined);
          delete state.current;
          continue;
        }
        const safeEntry = await this.resolveDirectoryEntry(workspace, workspaceId, state.current.basePath, entry);
        if (!safeEntry) continue;
        if (safeEntry.kind === "directory") {
          if (state.current.item.depth < maxDepth) {
            state.queue.push({ path: safeEntry.path, depth: state.current.item.depth + 1 });
          }
          continue;
        }
        if (matcher.test(safeEntry.path.replaceAll("\\", "/"))) {
          results.push({ path: safeEntry.path, size: safeEntry.size ?? 0 });
        }
      }
      const truncated = state.current !== undefined || state.queue.length > 0;
      const nextCursor = truncated ? await this.storeCursor(state) : undefined;
      return { workspaceId, pattern, results, truncated, ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) {
      await this.closeCursorState(state);
      throw error;
    }
  }

  public async writeFile(request: WriteFileRequest): Promise<WriteFileResult>;
  public async writeFile(workspaceId: string, relativePath: string, content: string | Uint8Array): Promise<WriteFileResult>;
  public async writeFile(
    first: WriteFileRequest | string,
    second?: string,
    third?: string | Uint8Array,
  ): Promise<WriteFileResult> {
    const request: WriteFileRequest = typeof first === "string"
      ? { workspaceId: first, path: second ?? "", content: third ?? "" }
      : first;
    if (typeof request.content !== "string" && !(request.content instanceof Uint8Array)) {
      throw new WorkspaceFileError("WRITE_FAILED");
    }
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      const resolved = await this.resolveExistingOrNew(workspace, request.path, "write");
      if (resolved.exists) {
        const metadata = await stat(resolved.canonicalPath ?? resolved.lexicalPath).catch(() => undefined);
        if (!metadata?.isFile()) throw new WorkspaceFileError("NOT_A_FILE");
      }
      const content = toBuffer(request.content);
      await this.atomicWrite(resolved.lexicalPath, content);
      return { workspaceId: request.workspaceId, path: request.path, bytes: content.byteLength };
    });
  }

  public async writeFileStream(
    workspaceId: string,
    relativePath: string,
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<WriteFileStreamResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    return this.withWorkspaceMutation(workspaceId, async () => {
      const workspace = this.requireWorkspace(workspaceId);
      const resolved = await this.resolveExistingOrNew(workspace, relativePath, "write");
      if (resolved.lexicalPath === resolved.rootPath || resolved.exists) {
        throw new WorkspaceFileError("PATH_EXISTS");
      }

      const temporaryPath = path.join(path.dirname(resolved.lexicalPath), `.mcp-bridge-download-${randomUUID()}.tmp`);
      const contentHash = createHash("sha256");
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let bytes = 0;
      try {
        handle = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
          0o600,
        );
        for await (const chunk of chunks) {
          const buffer = Buffer.from(chunk);
          if (bytes + buffer.byteLength > maxBytes) throw new WorkspaceFileError("FILE_TOO_LARGE");
          let offset = 0;
          while (offset < buffer.byteLength) {
            const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
            if (bytesWritten <= 0) throw new WorkspaceFileError("WRITE_FAILED");
            offset += bytesWritten;
          }
          bytes += buffer.byteLength;
          contentHash.update(buffer);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;

        try {
          await link(temporaryPath, resolved.lexicalPath);
        } catch (error) {
          if (isNodeError(error) && (error.code === "EXDEV" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP" || error.code === "EPERM")) {
            await copyFile(temporaryPath, resolved.lexicalPath, constants.COPYFILE_EXCL);
          } else {
            throw error;
          }
        }
        await unlink(temporaryPath);
        return { workspaceId, path: relativePath, bytes, contentHash: contentHash.digest("hex") };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
        throw mutationError(error);
      }
    });
  }

  public async createDirectories(workspaceId: string, relativePath: string): Promise<CreateDirectoriesResult> {
    return this.withWorkspaceMutation(workspaceId, async () => {
      const workspace = this.requireWorkspace(workspaceId);
      return this.createDirectoriesUnlocked(workspace, relativePath);
    });
  }

  public async createDirectory(request: CreateDirectoryRequest): Promise<CreateDirectoryResult>;
  public async createDirectory(workspaceId: string, relativePath: string): Promise<CreateDirectoryResult>;
  public async createDirectory(
    first: CreateDirectoryRequest | string,
    second?: string,
  ): Promise<CreateDirectoryResult> {
    const request: CreateDirectoryRequest = typeof first === "string"
      ? { workspaceId: first, path: second ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      const resolved = await this.resolveExistingOrNew(workspace, request.path, "create");
      if (resolved.lexicalPath === resolved.rootPath) throw new WorkspaceFileError("INVALID_OPERATION");
      if (resolved.exists) throw new WorkspaceFileError("PATH_EXISTS");

      try {
        await mkdir(resolved.lexicalPath);
      } catch (error) {
        throw mutationError(error);
      }
      return { workspaceId: request.workspaceId, path: request.path };
    });
  }

  public async movePath(request: MovePathRequest): Promise<MovePathResult>;
  public async movePath(workspaceId: string, sourcePath: string, targetPath: string): Promise<MovePathResult>;
  public async movePath(
    first: MovePathRequest | string,
    second?: string,
    third?: string,
  ): Promise<MovePathResult> {
    const request: MovePathRequest = typeof first === "string"
      ? { workspaceId: first, sourcePath: second ?? "", targetPath: third ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      const source = await this.resolveExisting(workspace, request.sourcePath, "write");
      if (source.lexicalPath === source.rootPath) throw new WorkspaceFileError("INVALID_OPERATION");
      if (source.kind !== "file" && source.kind !== "directory") throw new WorkspaceFileError("INVALID_OPERATION");

      const target = await this.resolveExistingOrNew(workspace, request.targetPath, "write");
      if (target.lexicalPath === target.rootPath) throw new WorkspaceFileError("PATH_EXISTS");
      if (source.lexicalPath === target.lexicalPath) throw new WorkspaceFileError("INVALID_OPERATION");

      const sameCanonicalTarget = process.platform === "win32"
        && target.exists
        && source.canonicalPath !== undefined
        && target.canonicalPath !== undefined
        && source.canonicalPath.toLowerCase() === target.canonicalPath.toLowerCase();
      if (target.exists && !sameCanonicalTarget) throw new WorkspaceFileError("PATH_EXISTS");
      if (source.kind === "directory" && isStrictlyInside(source.lexicalPath, target.lexicalPath)) {
        throw new WorkspaceFileError("INVALID_OPERATION");
      }

      if (sameCanonicalTarget) {
        const temporaryPath = path.join(path.dirname(source.lexicalPath), `.mcp-bridge-case-${randomUUID()}.tmp`);
        try {
          await rename(source.lexicalPath, temporaryPath);
          try {
            await rename(temporaryPath, target.lexicalPath);
          } catch (error) {
            await rename(temporaryPath, source.lexicalPath).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          throw mutationError(error);
        }
      } else if (source.kind === "file") {
        try {
          // Hard-linking first gives files a no-replace reservation on both POSIX
          // and Windows. If unlink fails, remove the reservation before failing.
          await link(source.lexicalPath, target.lexicalPath);
        } catch (error) {
          if (isNodeError(error) && (error.code === "EXDEV" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP")) {
            try {
              await copyFile(source.lexicalPath, target.lexicalPath, constants.COPYFILE_EXCL);
            } catch (copyError) {
              throw mutationError(copyError);
            }
          } else {
            throw mutationError(error);
          }
        }
        try {
          await unlink(source.lexicalPath);
        } catch (error) {
          await unlink(target.lexicalPath).catch(() => undefined);
          throw mutationError(error);
        }
      } else if (process.platform === "win32") {
        // Windows rename fails when the destination appears, so it provides the
        // required no-replace behavior without reserving an empty directory
        // (which Windows cannot subsequently replace with a directory).
        try {
          await rename(source.lexicalPath, target.lexicalPath);
        } catch (error) {
          const targetExists = await lstat(target.lexicalPath).then(() => true).catch(() => false);
          throw targetExists ? new WorkspaceFileError("PATH_EXISTS") : mutationError(error);
        }
      } else {
        let reserved = false;
        try {
          // Reserve the destination before rename; POSIX rename then replaces
          // only this empty directory, never an unrelated target.
          await mkdir(target.lexicalPath);
          reserved = true;
          await rename(source.lexicalPath, target.lexicalPath);
        } catch (error) {
          if (reserved) await rmdir(target.lexicalPath).catch(() => undefined);
          throw mutationError(error);
        }
      }

      return {
        workspaceId: request.workspaceId,
        sourcePath: request.sourcePath,
        targetPath: request.targetPath,
      };
    });
  }

  public async copyFile(request: CopyFileRequest): Promise<CopyFileResult>;
  public async copyFile(workspaceId: string, sourcePath: string, targetPath: string): Promise<CopyFileResult>;
  public async copyFile(
    first: CopyFileRequest | string,
    second?: string,
    third?: string,
  ): Promise<CopyFileResult> {
    const request: CopyFileRequest = typeof first === "string"
      ? { workspaceId: first, sourcePath: second ?? "", targetPath: third ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      return this.copyFileUnlocked(workspace, request);
    });
  }

  public async prepareFilePlan(
    workspaceId: string,
    operations: readonly FilePlanOperation[],
  ): Promise<PreparedFilePlanResult> {
    if (operations.length < 1 || operations.length > 200) throw new WorkspaceFileError("INVALID_OPERATION");
    const workspace = this.requireWorkspace(workspaceId);
    if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
    this.pruneExpiredFilePlans();

    const normalizedOperations: FilePlanOperation[] = [];
    const sources: Record<number, StoredFilePlanSource> = {};
    const targetExists: Record<number, boolean> = {};
    const mkdirExists: Record<number, boolean> = {};
    const plannedDirectories = new Set<string>();
    const targetKeys = new Set<string>();
    const movedSourceKeys = new Set<string>();
    let mkdirCount = 0;
    let copyCount = 0;
    let moveCount = 0;
    let totalBytes = 0;

    const ensureParent = async (relativePath: string): Promise<void> => {
      const parent = path.dirname(relativePath);
      if (parent === ".") return;
      if (plannedDirectories.has(workspacePathKey(parent))) return;
      const resolved = await this.resolveExisting(workspace, parent, "stat");
      if (resolved.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
    };

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      if (operation.kind === "mkdir") {
        validateWorkspaceRelativePath(operation.path);
        if (operation.path === ".") throw new WorkspaceFileError("INVALID_OPERATION");
        const normalizedPath = path.normalize(operation.path);
        await ensureParent(normalizedPath);
        const key = workspacePathKey(normalizedPath);
        if (targetKeys.has(key)) throw new WorkspaceFileError("PATH_EXISTS");
        targetKeys.add(key);
        const absolute = path.resolve(workspace.root, normalizedPath);
        const metadata = await lstat(absolute).catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw mutationError(error, "FILE_UNAVAILABLE");
        });
        if (metadata && !metadata.isDirectory()) throw new WorkspaceFileError("NOT_A_DIRECTORY");
        const exists = metadata?.isDirectory() === true;
        mkdirExists[index] = exists;
        if (!exists) plannedDirectories.add(key);
        normalizedOperations.push({ kind: "mkdir", path: normalizedPath });
        mkdirCount += 1;
        continue;
      }

      validateWorkspaceRelativePath(operation.sourcePath);
      validateWorkspaceRelativePath(operation.targetPath);
      if (operation.sourcePath === "." || operation.targetPath === ".") {
        throw new WorkspaceFileError("INVALID_OPERATION");
      }
      const sourcePath = path.normalize(operation.sourcePath);
      const targetPath = path.normalize(operation.targetPath);
      const sourceKey = workspacePathKey(sourcePath);
      const targetKey = workspacePathKey(targetPath);
      if (sourceKey === targetKey || targetKeys.has(targetKey)) throw new WorkspaceFileError("PATH_EXISTS");
      if (movedSourceKeys.has(sourceKey)) throw new WorkspaceFileError("INVALID_OPERATION");
      await ensureParent(targetPath);

      const source = await this.resolveExisting(workspace, sourcePath, "stat");
      if (source.kind !== "file") throw new WorkspaceFileError("NOT_A_FILE");
      const sourceAbsolute = source.canonicalPath ?? source.lexicalPath;
      const metadata = await stat(sourceAbsolute).catch(() => undefined);
      if (!metadata?.isFile()) throw new WorkspaceFileError("FILE_UNAVAILABLE");

      let contentHash: string | undefined;
      if (operation.expectedHash !== undefined) {
        if (!/^[a-f0-9]{64}$/iu.test(operation.expectedHash)) throw new WorkspaceFileError("INVALID_OPERATION");
        const hashed = await this.statFile(workspaceId, sourcePath, { includeHash: true });
        contentHash = hashed.contentHash;
        if (!contentHash || contentHash.toLowerCase() !== operation.expectedHash.toLowerCase()) {
          throw new WorkspaceFileError("CONTENT_MISMATCH");
        }
      }

      const targetAbsolute = path.resolve(workspace.root, targetPath);
      const targetMetadata = await lstat(targetAbsolute).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw mutationError(error, "FILE_UNAVAILABLE");
      });
      if (targetMetadata) throw new WorkspaceFileError("PATH_EXISTS");

      sources[index] = {
        path: sourcePath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ...(contentHash ? { contentHash } : {}),
      };
      targetExists[index] = false;
      targetKeys.add(targetKey);
      if (operation.kind === "move") movedSourceKeys.add(sourceKey);
      normalizedOperations.push({
        kind: operation.kind,
        sourcePath,
        targetPath,
        ...(operation.expectedHash ? { expectedHash: operation.expectedHash.toLowerCase() } : {}),
      });
      totalBytes += metadata.size;
      if (operation.kind === "copy") copyCount += 1;
      else moveCount += 1;
    }

    while (this.filePlans.size >= MAX_ACTIVE_FILE_PLANS) {
      const oldest = this.filePlans.keys().next().value as string | undefined;
      if (!oldest) break;
      this.filePlans.delete(oldest);
    }
    const planId = randomUUID();
    const expiresAt = Date.now() + FILE_PLAN_TTL_MS;
    const summary = {
      operations: normalizedOperations.length,
      mkdir: mkdirCount,
      copy: copyCount,
      move: moveCount,
      bytes: totalBytes,
    };
    this.filePlans.set(planId, {
      workspaceId,
      operations: normalizedOperations,
      sources,
      targetExists,
      mkdirExists,
      expiresAt,
      summary,
    });
    return { workspaceId, planId, expiresAt, ...summary };
  }

  public async executeFilePlan(workspaceId: string, planId: string): Promise<ExecuteFilePlanResult> {
    this.pruneExpiredFilePlans();
    const plan = this.filePlans.get(planId);
    if (!plan || plan.workspaceId !== workspaceId) throw new WorkspaceFileError("PLAN_NOT_FOUND");
    this.filePlans.delete(planId);

    return this.withWorkspaceMutation(workspaceId, async () => {
      const workspace = this.requireWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");

      for (let index = 0; index < plan.operations.length; index += 1) {
        const operation = plan.operations[index]!;
        if (operation.kind === "mkdir") {
          const absolute = path.resolve(workspace.root, operation.path);
          const metadata = await lstat(absolute).catch((error: unknown) => {
            if (isNodeError(error) && error.code === "ENOENT") return undefined;
            throw mutationError(error, "FILE_UNAVAILABLE");
          });
          const expectedExists = plan.mkdirExists[index] === true;
          if (expectedExists) {
            if (!metadata?.isDirectory()) throw new WorkspaceFileError("PLAN_STALE");
          } else if (metadata) {
            throw new WorkspaceFileError("PLAN_STALE");
          }
          continue;
        }

        const snapshot = plan.sources[index];
        if (!snapshot) throw new WorkspaceFileError("PLAN_STALE");
        const source = await this.resolveExisting(workspace, snapshot.path, "stat").catch(() => undefined);
        if (!source || source.kind !== "file") throw new WorkspaceFileError("PLAN_STALE");
        const metadata = await stat(source.canonicalPath ?? source.lexicalPath).catch(() => undefined);
        if (!metadata?.isFile() || metadata.size !== snapshot.size || metadata.mtimeMs !== snapshot.mtimeMs) {
          throw new WorkspaceFileError("PLAN_STALE");
        }
        if (snapshot.contentHash) {
          const hashed = await this.statFile(workspaceId, snapshot.path, { includeHash: true });
          if (hashed.contentHash !== snapshot.contentHash) throw new WorkspaceFileError("PLAN_STALE");
        }
        const targetAbsolute = path.resolve(workspace.root, operation.targetPath);
        const targetMetadata = await lstat(targetAbsolute).catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw mutationError(error, "FILE_UNAVAILABLE");
        });
        if (targetMetadata) throw new WorkspaceFileError("PLAN_STALE");
      }

      const completed: Array<
        | { kind: "mkdir"; created: readonly string[] }
        | { kind: "copy"; targetPath: string }
        | { kind: "move"; sourcePath: string; targetPath: string }
      > = [];
      try {
        for (const operation of plan.operations) {
          if (operation.kind === "mkdir") {
            const result = await this.createDirectoriesUnlocked(workspace, operation.path);
            completed.push({ kind: "mkdir", created: result.created });
          } else if (operation.kind === "copy") {
            await this.copyFileUnlocked(workspace, {
              workspaceId,
              sourcePath: operation.sourcePath,
              targetPath: operation.targetPath,
            });
            completed.push({ kind: "copy", targetPath: operation.targetPath });
          } else {
            await this.movePathUnlocked(workspace, {
              workspaceId,
              sourcePath: operation.sourcePath,
              targetPath: operation.targetPath,
            });
            completed.push({ kind: "move", sourcePath: operation.sourcePath, targetPath: operation.targetPath });
          }
        }
      } catch (error) {
        let rollbackFailed = false;
        for (const item of [...completed].reverse()) {
          try {
            if (item.kind === "copy") {
              const target = await this.resolveExisting(workspace, item.targetPath, "write");
              if (target.kind === "file") await unlink(target.lexicalPath);
            } else if (item.kind === "move") {
              await this.movePathUnlocked(workspace, { sourcePath: item.targetPath, targetPath: item.sourcePath, workspaceId });
            } else {
              for (const relative of [...item.created].reverse()) {
                const created = await this.resolveExisting(workspace, relative, "write");
                if (created.kind === "directory") await rmdir(created.lexicalPath);
              }
            }
          } catch {
            rollbackFailed = true;
          }
        }
        if (rollbackFailed) throw new WorkspaceFileError("PLAN_PARTIAL");
        throw error;
      }

      return { workspaceId, planId, ...plan.summary, completed: true };
    });
  }

  public async copyTree(
    workspaceId: string,
    sourcePath: string,
    targetPath: string,
    options: CopyTreeOptions = {},
  ): Promise<CopyTreeResult> {
    const maxFiles = options.maxFiles ?? 2_000;
    const maxDirectories = options.maxDirectories ?? 2_000;
    const maxEntries = options.maxEntries ?? 4_000;
    const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    if (!Number.isSafeInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > 10_000) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 2 * 1024 * 1024 * 1024) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }
    const include = options.include ?? [];
    const exclude = options.exclude ?? [];
    if (include.length > 32 || exclude.length > 32) throw new WorkspaceFileError("INVALID_GLOB");
    const includeMatchers = include.length > 0 ? include.map((pattern) => globToRegExp(pattern, true)) : [];
    const excludeMatchers = exclude.map((pattern) => globToRegExp(pattern, true));
    const normalizeRelative = (value: string): string => value.replaceAll("\\", "/");
    const isExcluded = (relative: string, directory = false): boolean => {
      const normalized = normalizeRelative(relative);
      return excludeMatchers.some((matcher) => matcher.test(normalized) || (directory && matcher.test(`${normalized}/_`)));
    };
    const isIncluded = (relative: string): boolean => {
      if (includeMatchers.length === 0) return true;
      const normalized = normalizeRelative(relative);
      return includeMatchers.some((matcher) => matcher.test(normalized));
    };

    return this.withWorkspaceMutation(workspaceId, async () => {
      const workspace = this.requireWorkspace(workspaceId);
      const source = await this.resolveExisting(workspace, sourcePath, "read");
      if (source.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
      const target = await this.resolveExistingOrNew(workspace, targetPath, "write");
      if (target.lexicalPath === target.rootPath || target.exists) throw new WorkspaceFileError("PATH_EXISTS");
      if (isStrictlyInside(source.lexicalPath, target.lexicalPath)) throw new WorkspaceFileError("INVALID_OPERATION");

      const sourceRoot = source.canonicalPath ?? source.lexicalPath;
      const directories: string[] = [];
      const files: Array<{ relative: string; source: string; metadata: Stats }> = [];
      const queue: Array<{ relative: string; absolute: string }> = [{ relative: "", absolute: sourceRoot }];
      let totalBytes = 0;
      let directoryCount = 1;

      while (queue.length > 0) {
        const current = queue.shift()!;
        const directory = await opendir(current.absolute).catch(() => undefined);
        if (!directory) throw new WorkspaceFileError("FILE_UNAVAILABLE");
        try {
          for await (const entry of directory) {
            const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
            if (entry.isSymbolicLink()) throw new PathSecurityError("SYMLINK_DISALLOWED");
            if (entry.isDirectory() && isExcluded(relative, true)) continue;
            if (!entry.isDirectory() && isExcluded(relative, false)) continue;

            const sourceRelative = sourcePath === "." ? relative : path.join(sourcePath, relative);
            const resolved = await workspace.sandbox.resolve({
              rootId: workspaceId,
              relativePath: sourceRelative,
              operation: entry.isDirectory() ? "list" : "read",
            });
            const canonical = resolved.canonicalPath ?? resolved.lexicalPath;
            if (entry.isDirectory()) {
              if (resolved.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
              directoryCount += 1;
              if (directoryCount > maxDirectories || directoryCount + files.length > maxEntries) {
                throw new WorkspaceFileError("FILE_TOO_LARGE");
              }
              directories.push(relative);
              queue.push({ relative, absolute: canonical });
              continue;
            }
            if (!entry.isFile() || resolved.kind !== "file") throw new WorkspaceFileError("INVALID_OPERATION");
            if (!isIncluded(relative)) continue;
            const metadata = await stat(canonical).catch(() => undefined);
            if (!metadata?.isFile()) throw new WorkspaceFileError("FILE_UNAVAILABLE");
            files.push({ relative, source: canonical, metadata });
            totalBytes += metadata.size;
            if (files.length > maxFiles || directoryCount + files.length > maxEntries || totalBytes > maxTotalBytes) {
              throw new WorkspaceFileError("FILE_TOO_LARGE");
            }
          }
        } finally {
          await directory.close().catch(() => undefined);
        }
      }

      let targetCreated = false;
      try {
        await mkdir(target.lexicalPath);
        targetCreated = true;
        for (const relative of directories) {
          const destination = path.join(target.lexicalPath, relative);
          await mkdir(destination);
        }
        for (const file of files) {
          const destination = path.join(target.lexicalPath, file.relative);
          await copyStableFileToNewTarget(file.source, destination, file.metadata);
        }
      } catch (error) {
        // Once the exact target directory has been created, do not perform path-based rollback.
        // Node's portable fs API cannot atomically say "unlink this path only if it is still the
        // same file/directory I created". A concurrent external delete+replacement could make
        // check-then-unlink/rmdir erase someone else's entry. Fail closed instead: preserve the
        // partial target for inspection and report the partial state explicitly.
        if (targetCreated) throw new WorkspaceFileError("COPY_TREE_PARTIAL");
        throw mutationError(error);
      }

      return {
        workspaceId,
        sourcePath,
        targetPath,
        files: files.length,
        directories: directoryCount,
        bytes: totalBytes,
      };
    });
  }

  public async deleteFile(request: DeletePathRequest): Promise<DeletePathResult>;
  public async deleteFile(workspaceId: string, relativePath: string): Promise<DeletePathResult>;
  public async deleteFile(first: DeletePathRequest | string, second?: string): Promise<DeletePathResult> {
    const request: DeletePathRequest = typeof first === "string"
      ? { workspaceId: first, path: second ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      const resolved = await this.resolveExisting(workspace, request.path, "write");
      if (resolved.lexicalPath === resolved.rootPath || resolved.kind !== "file") {
        throw new WorkspaceFileError("NOT_A_FILE");
      }
      try {
        await unlink(resolved.lexicalPath);
      } catch (error) {
        throw mutationError(error);
      }
      return { workspaceId: request.workspaceId, path: request.path };
    });
  }

  public async deleteDirectory(request: DeletePathRequest): Promise<DeletePathResult>;
  public async deleteDirectory(workspaceId: string, relativePath: string): Promise<DeletePathResult>;
  public async deleteDirectory(first: DeletePathRequest | string, second?: string): Promise<DeletePathResult> {
    const request: DeletePathRequest = typeof first === "string"
      ? { workspaceId: first, path: second ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      const resolved = await this.resolveExisting(workspace, request.path, "write");
      if (resolved.lexicalPath === resolved.rootPath) throw new WorkspaceFileError("INVALID_OPERATION");
      if (resolved.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
      try {
        await rmdir(resolved.lexicalPath);
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
          throw new WorkspaceFileError("DIRECTORY_NOT_EMPTY");
        }
        throw mutationError(error);
      }
      return { workspaceId: request.workspaceId, path: request.path };
    });
  }

  public async applyPatch(request: ApplyPatchRequest): Promise<WriteFileResult>;
  public async applyPatch(workspaceId: string, relativePath: string, patch: PatchInput): Promise<WriteFileResult>;
  public async applyPatch(
    first: ApplyPatchRequest | string,
    second?: string,
    third?: PatchInput,
  ): Promise<WriteFileResult> {
    const request: ApplyPatchRequest = typeof first === "string"
      ? { workspaceId: first, path: second ?? "", patch: third ?? "" }
      : first;
    return this.withWorkspaceMutation(request.workspaceId, async () => {
      const workspace = this.requireWorkspace(request.workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const source = await this.readFile(request.workspaceId, request.path);
      const patched = applyPatchText(source.content, request.patch, request.path);
      const resolved = await this.resolveExisting(workspace, request.path, "write");
      if (resolved.kind !== "file") throw new WorkspaceFileError("NOT_A_FILE");
      const content = toBuffer(patched);
      await this.atomicWrite(resolved.lexicalPath, content);
      return { workspaceId: request.workspaceId, path: request.path, bytes: content.byteLength };
    });
  }

  public listWorkspaces(): readonly WorkspaceInfo[] {
    return [...this.workspaces.values()].map(({ workspaceId, root, mode, allowedScripts }) => ({
      workspaceId,
      root,
      mode,
      allowedScripts,
    }));
  }

  private async resolveDirectoryEntry(
    workspace: RegisteredWorkspace,
    workspaceId: string,
    basePath: string,
    entry: Dirent,
  ): Promise<DirectoryEntry | undefined> {
    if (entry.isSymbolicLink()) return undefined;
    const childPath = basePath ? path.join(basePath, entry.name) : entry.name;
    try {
      const child = await workspace.sandbox.resolve({
        rootId: workspaceId,
        relativePath: childPath,
        operation: "list",
      });
      if (child.kind !== "file" && child.kind !== "directory") return undefined;
      const childMetadata = await stat(child.canonicalPath ?? child.lexicalPath);
      if (child.kind === "file" && childMetadata.isFile()) {
        return { name: entry.name, path: childPath, kind: "file", size: childMetadata.size };
      }
      if (child.kind === "directory" && childMetadata.isDirectory()) {
        return { name: entry.name, path: childPath, kind: "directory" };
      }
      return undefined;
    } catch (error) {
      if (error instanceof PathSecurityError || (isNodeError(error) && error.code === "ENOENT")) return undefined;
      throw new WorkspaceFileError("FILE_UNAVAILABLE");
    }
  }

  private async openTraversalDirectory(
    workspace: RegisteredWorkspace,
    workspaceId: string,
    item: SearchQueueItem,
  ): Promise<OpenTraversalDirectory> {
    const resolved = await this.resolveExisting(workspace, item.path, "list");
    const directoryPath = resolved.canonicalPath ?? resolved.lexicalPath;
    const metadata = await stat(directoryPath).catch(() => undefined);
    if (!metadata) throw new WorkspaceFileError("FILE_UNAVAILABLE");
    if (!metadata.isDirectory()) throw new WorkspaceFileError("NOT_A_DIRECTORY");
    const directory = await opendir(directoryPath).catch(() => undefined);
    if (!directory) throw new WorkspaceFileError("FILE_UNAVAILABLE");
    return { item, directory, basePath: item.path === "." ? "" : item.path };
  }

  private async storeCursor(state: CursorState): Promise<string> {
    await this.pruneExpiredCursors();
    while (this.traversalCursors.size >= MAX_ACTIVE_CURSORS) {
      const oldest = this.traversalCursors.entries().next().value as [string, StoredCursorState] | undefined;
      if (!oldest) break;
      this.traversalCursors.delete(oldest[0]);
      clearTimeout(oldest[1].timer);
      await this.closeCursorState(oldest[1].state);
    }
    const cursor = randomUUID();
    const timer = setTimeout(() => {
      const stored = this.traversalCursors.get(cursor);
      if (!stored) return;
      this.traversalCursors.delete(cursor);
      void this.closeCursorState(stored.state);
    }, CURSOR_TTL_MS);
    timer.unref();
    this.traversalCursors.set(cursor, { state, expiresAt: Date.now() + CURSOR_TTL_MS, timer });
    return cursor;
  }

  private async takeCursor<K extends CursorState["kind"]>(
    cursor: string,
    kind: K,
  ): Promise<Extract<CursorState, { kind: K }>> {
    await this.pruneExpiredCursors();
    const stored = this.traversalCursors.get(cursor);
    if (!stored || stored.state.kind !== kind) throw new WorkspaceFileError("INVALID_CURSOR");
    this.traversalCursors.delete(cursor);
    clearTimeout(stored.timer);
    return stored.state as Extract<CursorState, { kind: K }>;
  }

  private pruneExpiredFilePlans(): void {
    const now = Date.now();
    for (const [planId, plan] of this.filePlans) {
      if (plan.expiresAt <= now) this.filePlans.delete(planId);
    }
  }

  private pruneExpiredTreeSnapshots(): void {
    const now = Date.now();
    for (const [snapshotId, snapshot] of this.treeSnapshots) {
      if (snapshot.expiresAt <= now) this.treeSnapshots.delete(snapshotId);
    }
  }

  private async pruneExpiredCursors(): Promise<void> {
    const now = Date.now();
    for (const [cursor, stored] of this.traversalCursors) {
      if (stored.expiresAt > now) continue;
      this.traversalCursors.delete(cursor);
      clearTimeout(stored.timer);
      await this.closeCursorState(stored.state);
    }
  }

  private async closeCursorState(state: CursorState): Promise<void> {
    if (state.kind === "directory") {
      await state.directory.close().catch(() => undefined);
      return;
    }
    await state.current?.directory.close().catch(() => undefined);
    delete state.current;
  }

  private async resolveExisting(
    workspace: RegisteredWorkspace,
    relativePath: string,
    operation: PathOperation,
  ): Promise<ResolvedPath> {
    let resolved: ResolvedPath;
    try {
      resolved = await workspace.sandbox.resolve({
        rootId: workspace.workspaceId,
        relativePath,
        operation,
      });
    } catch (error) {
      if (error instanceof PathSecurityError && error.code === "MISSING_TARGET") {
        throw new WorkspaceFileError("FILE_NOT_FOUND");
      }
      throw error;
    }
    if (!resolved.exists || !resolved.canonicalPath) throw new WorkspaceFileError("FILE_NOT_FOUND");
    return resolved;
  }

  private async resolveExistingOrNew(
    workspace: RegisteredWorkspace,
    relativePath: string,
    operation: PathOperation,
  ): Promise<ResolvedPath> {
    return workspace.sandbox.resolve({
      rootId: workspace.workspaceId,
      relativePath,
      operation,
    });
  }

  private async createDirectoriesUnlocked(
    workspace: RegisteredWorkspace,
    relativePath: string,
  ): Promise<CreateDirectoriesResult> {
    if (relativePath === ".") throw new WorkspaceFileError("INVALID_OPERATION");
    const segments = relativePath.split(/[\\/]/u);
    if (segments.length === 0) throw new WorkspaceFileError("INVALID_OPERATION");
    const created: string[] = [];
    let current = "";
    for (const segment of segments) {
      if (!segment || segment === "." || segment === "..") {
        throw new PathSecurityError("PATH_TRAVERSAL");
      }
      current = current ? path.join(current, segment) : segment;
      const resolved = await this.resolveExistingOrNew(workspace, current, "create");
      if (resolved.exists) {
        if (resolved.kind !== "directory") throw new WorkspaceFileError("NOT_A_DIRECTORY");
        continue;
      }
      try {
        await mkdir(resolved.lexicalPath);
      } catch (error) {
        throw mutationError(error);
      }
      created.push(current);
    }
    return { workspaceId: workspace.workspaceId, path: relativePath, created };
  }

  private async copyFileUnlocked(workspace: RegisteredWorkspace, request: CopyFileRequest): Promise<CopyFileResult> {
    const source = await this.resolveExisting(workspace, request.sourcePath, "read");
    if (source.kind !== "file") throw new WorkspaceFileError("NOT_A_FILE");

    const target = await this.resolveExistingOrNew(workspace, request.targetPath, "write");
    if (target.lexicalPath === target.rootPath || target.exists) throw new WorkspaceFileError("PATH_EXISTS");

    const sourcePath = source.canonicalPath ?? source.lexicalPath;
    const metadata = await stat(sourcePath).catch(() => undefined);
    if (!metadata?.isFile()) throw new WorkspaceFileError("NOT_A_FILE");
    try {
      await copyFile(sourcePath, target.lexicalPath, constants.COPYFILE_EXCL);
    } catch (error) {
      throw mutationError(error);
    }
    return {
      workspaceId: workspace.workspaceId,
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
      bytes: metadata.size,
    };
  }

  private async movePathUnlocked(workspace: RegisteredWorkspace, request: MovePathRequest): Promise<MovePathResult> {
    const source = await this.resolveExisting(workspace, request.sourcePath, "write");
    if (source.lexicalPath === source.rootPath) throw new WorkspaceFileError("INVALID_OPERATION");
    if (source.kind !== "file" && source.kind !== "directory") throw new WorkspaceFileError("INVALID_OPERATION");

    const target = await this.resolveExistingOrNew(workspace, request.targetPath, "write");
    if (target.lexicalPath === target.rootPath) throw new WorkspaceFileError("PATH_EXISTS");
    if (source.lexicalPath === target.lexicalPath) throw new WorkspaceFileError("INVALID_OPERATION");

    const sameCanonicalTarget = process.platform === "win32"
      && target.exists
      && source.canonicalPath !== undefined
      && target.canonicalPath !== undefined
      && source.canonicalPath.toLowerCase() === target.canonicalPath.toLowerCase();
    if (target.exists && !sameCanonicalTarget) throw new WorkspaceFileError("PATH_EXISTS");
    if (source.kind === "directory" && isStrictlyInside(source.lexicalPath, target.lexicalPath)) {
      throw new WorkspaceFileError("INVALID_OPERATION");
    }

    if (sameCanonicalTarget) {
      const temporaryPath = path.join(path.dirname(source.lexicalPath), `.mcp-bridge-case-${randomUUID()}.tmp`);
      try {
        await rename(source.lexicalPath, temporaryPath);
        try {
          await rename(temporaryPath, target.lexicalPath);
        } catch (error) {
          await rename(temporaryPath, source.lexicalPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw mutationError(error);
      }
    } else if (source.kind === "file") {
      try {
        await link(source.lexicalPath, target.lexicalPath);
      } catch (error) {
        if (isNodeError(error) && (error.code === "EXDEV" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP")) {
          try {
            await copyFile(source.lexicalPath, target.lexicalPath, constants.COPYFILE_EXCL);
          } catch (copyError) {
            throw mutationError(copyError);
          }
        } else {
          throw mutationError(error);
        }
      }
      try {
        await unlink(source.lexicalPath);
      } catch (error) {
        await unlink(target.lexicalPath).catch(() => undefined);
        throw mutationError(error);
      }
    } else if (process.platform === "win32") {
      try {
        await rename(source.lexicalPath, target.lexicalPath);
      } catch (error) {
        const targetExists = await lstat(target.lexicalPath).then(() => true).catch(() => false);
        throw targetExists ? new WorkspaceFileError("PATH_EXISTS") : mutationError(error);
      }
    } else {
      let reserved = false;
      try {
        await mkdir(target.lexicalPath);
        reserved = true;
        await rename(source.lexicalPath, target.lexicalPath);
      } catch (error) {
        if (reserved) await rmdir(target.lexicalPath).catch(() => undefined);
        throw mutationError(error);
      }
    }

    return {
      workspaceId: workspace.workspaceId,
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
    };
  }

  private async hashStableFile(lexicalPath: string, expected: Stats): Promise<string> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const leaf = await lstat(lexicalPath);
      if (leaf.isSymbolicLink()) throw new PathSecurityError("SYMLINK_DISALLOWED");
      handle = await open(lexicalPath, constants.O_RDONLY | noFollowFlag());
      const before = await handle.stat();
      if (!sameStableFileState(expected, before)) throw new WorkspaceFileError("FILE_UNAVAILABLE");

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const requested = Math.min(buffer.byteLength, before.size - position);
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (bytesRead <= 0) throw new WorkspaceFileError("FILE_UNAVAILABLE");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }

      const after = await handle.stat();
      if (!sameStableFileState(before, after) || !sameStableFileState(expected, after)) {
        throw new WorkspaceFileError("FILE_UNAVAILABLE");
      }
      return hash.digest("hex");
    } catch (error) {
      if (error instanceof PathSecurityError || error instanceof WorkspaceFileError) throw error;
      if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENXIO")) {
        throw new PathSecurityError("SYMLINK_DISALLOWED");
      }
      throw new WorkspaceFileError("FILE_UNAVAILABLE");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async atomicWrite(targetPath: string, content: Buffer): Promise<void> {
    const temporaryPath = path.join(path.dirname(targetPath), `.mcp-bridge-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new WorkspaceFileError("WRITE_FAILED");
    }
  }

  private async withWorkspaceMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.mutationTails.set(workspaceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(workspaceId) === tail) this.mutationTails.delete(workspaceId);
    }
  }

  private requireWorkspace(workspaceId: string): RegisteredWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    return workspace;
  }
}
