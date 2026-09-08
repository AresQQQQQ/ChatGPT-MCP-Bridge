import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createSanitizedChildEnv, DEFAULT_COMMAND_LIMITS } from "../commands/command-planner.js";
import { ProcessRunner } from "../commands/command-runner.js";
import { CommandPolicyError, type CommandExecutor, type PlannedCommand } from "../commands/types.js";
import { isBlockedWorkspacePath, isPathContained, validateWorkspaceRelativePath } from "../security/path-sandbox.js";
import { SAFE_GIT_PATHSPECS } from "./git-operations.js";

const CHECKPOINT_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_ACTIVE_CHECKPOINTS = 32;
const DEFAULT_MAX_HASH_BYTES = 512 * 1024 * 1024;
const HARD_MAX_HASH_BYTES = 1024 * 1024 * 1024;
const MAX_DIRTY_PATHS = 5_000;
const MAX_COMPARE_PATHS = 2_000;

const STATUS_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignored=no",
  "--no-renames",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const HEAD_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "rev-parse",
  "--verify",
  "HEAD",
] as const;

interface DirtyPathState {
  readonly status: string;
  readonly kind: "file" | "missing" | "other";
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly contentHash?: string;
}

interface StoredCheckpoint {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly head?: string;
  readonly paths: ReadonlyMap<string, DirtyPathState>;
  readonly ignoredPaths: number;
  readonly hashedBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface WorktreeCheckpointResult {
  readonly workspaceId: string;
  readonly checkpointId: string;
  readonly head?: string;
  readonly dirtyPaths: number;
  readonly ignoredPaths: number;
  readonly hashedBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface WorktreeCheckpointComparison {
  readonly workspaceId: string;
  readonly checkpointId: string;
  readonly headBefore?: string;
  readonly headAfter?: string;
  readonly headChanged: boolean;
  readonly preExistingUnchanged: readonly string[];
  readonly preExistingAdditionallyModified: readonly string[];
  readonly addedByTask: readonly string[];
  readonly resolvedPreExisting: readonly string[];
  readonly ignoredPathsBefore: number;
  readonly ignoredPathsAfter: number;
  readonly truncated: boolean;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

async function canonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not directory");
    return canonical;
  } catch {
    throw new CommandPolicyError("workspace root is unavailable");
  }
}

function sameState(left: DirtyPathState, right: DirtyPathState): boolean {
  return left.status === right.status &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.contentHash === right.contentHash;
}

export class WorktreeCheckpointStore {
  private readonly checkpoints = new Map<string, StoredCheckpoint>();

  public constructor(private readonly executor: CommandExecutor = new ProcessRunner()) {}

  public async create(
    workspaceId: string,
    workspaceRoot: string,
    maxHashBytes = DEFAULT_MAX_HASH_BYTES,
  ): Promise<WorktreeCheckpointResult> {
    this.assertHashLimit(maxHashBytes);
    this.pruneExpired();
    const root = await canonicalWorkspaceRoot(workspaceRoot);
    const snapshot = await this.capture(root, maxHashBytes);
    while (this.checkpoints.size >= MAX_ACTIVE_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
    const checkpointId = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + CHECKPOINT_TTL_MS;
    this.checkpoints.set(checkpointId, {
      workspaceId,
      workspaceRoot: root,
      ...(snapshot.head ? { head: snapshot.head } : {}),
      paths: snapshot.paths,
      ignoredPaths: snapshot.ignoredPaths,
      hashedBytes: snapshot.hashedBytes,
      createdAt,
      expiresAt,
    });
    return {
      workspaceId,
      checkpointId,
      ...(snapshot.head ? { head: snapshot.head } : {}),
      dirtyPaths: snapshot.paths.size,
      ignoredPaths: snapshot.ignoredPaths,
      hashedBytes: snapshot.hashedBytes,
      createdAt,
      expiresAt,
    };
  }

  public async compare(
    workspaceId: string,
    workspaceRoot: string,
    checkpointId: string,
    maxHashBytes = DEFAULT_MAX_HASH_BYTES,
    maxPaths = 500,
  ): Promise<WorktreeCheckpointComparison> {
    this.assertHashLimit(maxHashBytes);
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > MAX_COMPARE_PATHS) {
      throw new CommandPolicyError("worktree checkpoint compare path limit is invalid");
    }
    this.pruneExpired();
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint || checkpoint.workspaceId !== workspaceId) throw new CommandPolicyError("worktree checkpoint was not found or has expired");
    const root = await canonicalWorkspaceRoot(workspaceRoot);
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
    const checkpointRootKey = process.platform === "win32" ? checkpoint.workspaceRoot.toLowerCase() : checkpoint.workspaceRoot;
    if (rootKey !== checkpointRootKey) throw new CommandPolicyError("worktree checkpoint belongs to another workspace root");

    const current = await this.capture(root, maxHashBytes);
    const preExistingUnchanged: string[] = [];
    const preExistingAdditionallyModified: string[] = [];
    const addedByTask: string[] = [];
    const resolvedPreExisting: string[] = [];
    let differences = 0;

    for (const [relativePath, before] of checkpoint.paths) {
      const after = current.paths.get(relativePath);
      if (!after) {
        differences += 1;
        if (differences <= maxPaths) resolvedPreExisting.push(relativePath);
      } else if (sameState(before, after)) {
        if (preExistingUnchanged.length < maxPaths) preExistingUnchanged.push(relativePath);
      } else {
        differences += 1;
        if (differences <= maxPaths) preExistingAdditionallyModified.push(relativePath);
      }
    }
    for (const relativePath of current.paths.keys()) {
      if (checkpoint.paths.has(relativePath)) continue;
      differences += 1;
      if (differences <= maxPaths) addedByTask.push(relativePath);
    }

    return {
      workspaceId,
      checkpointId,
      ...(checkpoint.head ? { headBefore: checkpoint.head } : {}),
      ...(current.head ? { headAfter: current.head } : {}),
      headChanged: checkpoint.head !== current.head,
      preExistingUnchanged,
      preExistingAdditionallyModified,
      addedByTask,
      resolvedPreExisting,
      ignoredPathsBefore: checkpoint.ignoredPaths,
      ignoredPathsAfter: current.ignoredPaths,
      truncated: differences > maxPaths,
    };
  }

  private assertHashLimit(maxHashBytes: number): void {
    if (!Number.isSafeInteger(maxHashBytes) || maxHashBytes < 1 || maxHashBytes > HARD_MAX_HASH_BYTES) {
      throw new CommandPolicyError("worktree checkpoint hash limit is invalid");
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [checkpointId, checkpoint] of this.checkpoints) {
      if (checkpoint.expiresAt <= now) this.checkpoints.delete(checkpointId);
    }
  }

  private async capture(root: string, maxHashBytes: number): Promise<{
    readonly head?: string;
    readonly paths: ReadonlyMap<string, DirtyPathState>;
    readonly ignoredPaths: number;
    readonly hashedBytes: number;
  }> {
    const statusResult = await this.runGit(root, STATUS_ARGS);
    if (statusResult.outcome !== "completed" || statusResult.exitCode !== 0 || statusResult.truncated) {
      throw new CommandPolicyError("Could not inspect Git worktree for checkpoint");
    }
    const headResult = await this.runGit(root, HEAD_ARGS);
    const head = headResult.outcome === "completed" && headResult.exitCode === 0 && /^[0-9a-f]{40,64}\s*$/iu.test(headResult.stdout)
      ? headResult.stdout.trim()
      : undefined;

    const paths = new Map<string, DirtyPathState>();
    let ignoredPaths = 0;
    let hashedBytes = 0;
    const records = statusResult.stdout.split("\0").filter(Boolean);
    if (records.length > MAX_DIRTY_PATHS) throw new CommandPolicyError("worktree has too many dirty paths for a checkpoint");

    for (const record of records) {
      if (record.length < 4 || record[2] !== " ") {
        ignoredPaths += 1;
        continue;
      }
      const status = record.slice(0, 2);
      const relativePath = record.slice(3).replaceAll("\\", "/");
      try {
        validateWorkspaceRelativePath(relativePath);
      } catch {
        ignoredPaths += 1;
        continue;
      }
      if (isBlockedWorkspacePath(relativePath)) {
        ignoredPaths += 1;
        continue;
      }
      const state = await this.capturePathState(root, relativePath, status, maxHashBytes - hashedBytes);
      if (state.contentHash && state.size !== undefined) hashedBytes += state.size;
      paths.set(relativePath, state);
    }
    return {
      ...(head ? { head } : {}),
      paths,
      ignoredPaths,
      hashedBytes,
    };
  }

  private async capturePathState(
    root: string,
    relativePath: string,
    status: string,
    remainingHashBytes: number,
  ): Promise<DirtyPathState> {
    const lexicalPath = path.resolve(root, relativePath);
    const metadata = await lstat(lexicalPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) return { status, kind: "missing" };
    if (!metadata.isFile()) {
      return { status, kind: "other", size: metadata.size, mtimeMs: metadata.mtimeMs };
    }
    if (metadata.size > remainingHashBytes) throw new CommandPolicyError("worktree checkpoint exceeded its hash-byte limit");

    const canonical = await realpath(lexicalPath).catch(() => undefined);
    if (!canonical || !isPathContained(root, canonical)) throw new CommandPolicyError("worktree checkpoint encountered an unsafe path");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lexicalPath, constants.O_RDONLY | noFollowFlag());
      const before = await handle.stat();
      if (!before.isFile() || before.size !== metadata.size || before.mtimeMs !== metadata.mtimeMs) {
        throw new CommandPolicyError("worktree changed while checkpoint was being created");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const requested = Math.min(buffer.byteLength, before.size - position);
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (bytesRead <= 0) throw new CommandPolicyError("worktree file became unavailable during checkpoint");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new CommandPolicyError("worktree changed while checkpoint was being created");
      }
      return {
        status,
        kind: "file",
        size: before.size,
        mtimeMs: before.mtimeMs,
        contentHash: hash.digest("hex"),
      };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async runGit(root: string, args: readonly string[]) {
    const limits = DEFAULT_COMMAND_LIMITS["git-status"];
    const command: PlannedCommand = {
      executable: "git",
      args,
      cwd: root,
      env: createSanitizedChildEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      timeoutMs: limits.timeoutMs,
      outputLimits: {
        maxStdoutBytes: limits.maxStdoutBytes,
        maxStderrBytes: limits.maxStderrBytes,
        maxTotalBytes: limits.maxTotalBytes,
      },
      killGraceMs: limits.killGraceMs,
      kind: "git-status",
    };
    return this.executor.run(command);
  }
}
