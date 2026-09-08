import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSanitizedChildEnv,
  DEFAULT_COMMAND_LIMITS,
  HARD_MAX_COMMAND_TIMEOUT_MS,
  HARD_MAX_STDERR_BYTES,
  HARD_MAX_STDOUT_BYTES,
  HARD_MAX_TOTAL_OUTPUT_BYTES,
} from "../commands/command-planner.js";
import { ProcessRunner } from "../commands/command-runner.js";
import type {
  CommandExecutionResult,
  CommandExecutor,
  CommandKind,
  OutputLimits,
  PlannedCommand,
} from "../commands/types.js";
import { CommandPolicyError } from "../commands/types.js";
import { isBlockedWorkspacePath } from "../security/path-sandbox.js";

export const SAFE_GIT_PATHSPECS = [
  ".",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/id_rsa",
  ":(exclude,glob)**/id_dsa",
  ":(exclude,glob)**/id_ecdsa",
  ":(exclude,glob)**/id_ed25519",
  ":(exclude,glob)**/id_xmss",
  ":(exclude,glob)**/authorized_keys",
  ":(exclude,glob)**/credentials",
  ":(exclude,glob)**/credentials.json",
  ":(exclude,glob)**/service-account.json",
  ":(exclude,glob)**/.git-credentials",
  ":(exclude,glob)**/.netrc",
  ":(exclude,glob)**/.npmrc",
  ":(exclude,glob)**/.pypirc",
  ":(exclude,glob)**/known_hosts",
  ":(exclude,glob)**/private_key",
  ":(exclude,glob)**/.ssh/**",
  ":(exclude,glob)**/.gnupg/**",
  ":(exclude,glob)**/.aws/**",
  ":(exclude,glob)**/.azure/**",
  ":(exclude,glob)**/.kube/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/out/**",
  ":(exclude,glob)**/coverage/**",
  ":(exclude,glob)**/.cache/**",
] as const;

const GIT_STATUS_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "core.pager=cat",
  "status",
  "--short",
  "--branch",
  "--untracked-files=normal",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const GIT_DIFF_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "core.pager=cat",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const GIT_LOG_COMMON_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "core.pager=cat",
  "log",
  "--no-color",
  "--no-decorate",
  "--no-patch",
  "--no-ext-diff",
  "--no-textconv",
  "--format=fuller",
] as const;

export const GIT_LOG_ARGS = [
  ...GIT_LOG_COMMON_ARGS,
  "--max-count=20",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const GIT_SHOW_COMMON_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "core.pager=cat",
  "show",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
] as const;

export const GIT_SHOW_ARGS = [
  ...GIT_SHOW_COMMON_ARGS,
  "HEAD",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const DEFAULT_LOG_MAX_COUNT = 20;
const MAX_LOG_MAX_COUNT = 100;
const MAX_GIT_ADD_PATHS = 100;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const SAFE_COMMITISH_PATTERN = /^(?:HEAD|HEAD(?:~[0-9]{1,9}|\^[0-9]{1,9})|[0-9A-Fa-f]{4,64})$/u;

const GIT_WRITE_COMMON_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
] as const;

export const GIT_INIT_ARGS = [
  ...GIT_WRITE_COMMON_ARGS,
  "init",
  "--quiet",
] as const;

export const GIT_ADD_ARGS = [
  ...GIT_WRITE_COMMON_ARGS,
  "add",
  "--all",
  "--",
  ...SAFE_GIT_PATHSPECS,
] as const;

const GIT_STAGED_PATHS_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "core.pager=cat",
  "diff",
  "--cached",
  "--name-only",
  "-z",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--",
] as const;

const GIT_HEAD_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "rev-parse",
  "--verify",
  "HEAD",
] as const;

const GIT_HEAD_DETAILS_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "show",
  "-s",
  "--no-color",
  "--format=%H%x00%P%x00%B",
  "HEAD",
] as const;

export interface GitOperationOptions {
  /** Trusted, already selected workspace root from the host application. */
  readonly workspaceRoot: string;
  readonly gitExecutable?: string;
  readonly timeoutMs?: number;
  readonly outputLimits?: Partial<OutputLimits>;
  readonly executor?: CommandExecutor;
}

export interface GitDiffOptions extends GitOperationOptions {
  /** Repository-relative path; no flags, absolute paths, or traversal segments. */
  readonly path?: string;
}

export interface GitLogOptions extends GitOperationOptions {
  /** Maximum number of commits to return; the service clamps this to 1..100. */
  readonly maxCount?: number;
  /** Repository-relative path; no flags, absolute paths, or traversal segments. */
  readonly path?: string;
}

export interface GitShowOptions extends GitOperationOptions {
  /** A deliberately narrow commit-ish: HEAD, HEAD~N, HEAD^N, or a hex object id. */
  readonly commitish?: string;
  /** When present, return this file's contents at the selected revision. */
  readonly path?: string;
}

export interface GitAddOptions extends GitOperationOptions {
  /** Optional repository-relative files/directories. Omit to stage all safe workspace changes. */
  readonly paths?: readonly string[];
}

export interface GitCommitOptions extends GitOperationOptions {
  /** Plain commit subject/message. Flags and control characters are not accepted. */
  readonly message: string;
}

export interface GitCommitReconciliation {
  readonly status: "confirmed-completed" | "confirmed-not-completed" | "indeterminate";
  readonly originalOutcome: CommandExecutionResult["outcome"];
  readonly beforeHead?: string;
  readonly afterHead?: string;
}

export interface GitIndexLockDiagnostic {
  readonly preExisting: boolean;
  readonly presentAfter: boolean;
}

export interface GitOperationResult extends CommandExecutionResult {
  readonly operation: "status" | "diff" | "log" | "show" | "init" | "add" | "commit";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly reconciliation?: GitCommitReconciliation;
  readonly indexLock?: GitIndexLockDiagnostic;
}

function normalizeRepositoryRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\\") ||
    value.startsWith("-") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new CommandPolicyError("Git path must be a safe repository-relative path");
  }
  if (value.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw new CommandPolicyError("Git path contains an invalid traversal segment");
  }
  if (isBlockedWorkspacePath(value)) {
    throw new CommandPolicyError("Git path is blocked by the workspace security policy");
  }
  return value;
}

function literalPathspec(value: string): string {
  return `:(literal)${normalizeRepositoryRelativePath(value)}`;
}

function assertCommitish(value: string): void {
  if (!SAFE_COMMITISH_PATTERN.test(value)) {
    throw new CommandPolicyError("Git commit-ish is not allowed");
  }
}

function normalizeAddPaths(paths: readonly string[] | undefined): readonly string[] | undefined {
  if (paths === undefined) return undefined;
  if (paths.length < 1 || paths.length > MAX_GIT_ADD_PATHS) {
    throw new CommandPolicyError(`Git add accepts between 1 and ${MAX_GIT_ADD_PATHS} paths`);
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const normalized = normalizeRepositoryRelativePath(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

function normalizeCommitMessage(message: string): string {
  if (
    typeof message !== "string" ||
    message.length > MAX_COMMIT_MESSAGE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(message)
  ) {
    throw new CommandPolicyError("Git commit message is invalid");
  }
  const normalized = message.trim();
  if (!normalized) throw new CommandPolicyError("Git commit message cannot be empty");
  return normalized;
}

function clampLogMaxCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOG_MAX_COUNT;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommandPolicyError("Git log maxCount must be a finite number");
  }
  return Math.min(MAX_LOG_MAX_COUNT, Math.max(1, Math.trunc(value)));
}

function withSafePathspecs(args: readonly string[], relativePath: string | undefined): readonly string[] {
  const separator = args.indexOf("--");
  if (separator < 0) throw new CommandPolicyError("Git command is missing its path separator");
  if (relativePath === undefined) return args;
  return [
    ...args.slice(0, separator + 1),
    literalPathspec(relativePath),
    ...args.slice(separator + 2),
  ];
}

async function canonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new CommandPolicyError("workspace root is unavailable");
  }
}

type GitCommandKind = Extract<CommandKind, `git-${string}`>;

const GIT_OPERATION_KIND: Readonly<Record<GitOperationResult["operation"], GitCommandKind>> = {
  status: "git-status",
  diff: "git-diff",
  log: "git-log",
  show: "git-show",
  init: "git-init",
  add: "git-add",
  commit: "git-commit",
};

function buildLimits(kind: GitCommandKind, options: GitOperationOptions): {
  timeoutMs: number;
  outputLimits: OutputLimits;
  killGraceMs: number;
} {
  const defaults = DEFAULT_COMMAND_LIMITS[kind];
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  const outputLimits = {
    maxStdoutBytes: options.outputLimits?.maxStdoutBytes ?? defaults.maxStdoutBytes,
    maxStderrBytes: options.outputLimits?.maxStderrBytes ?? defaults.maxStderrBytes,
    maxTotalBytes: options.outputLimits?.maxTotalBytes ?? defaults.maxTotalBytes,
  };
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(outputLimits.maxStdoutBytes) ||
    outputLimits.maxStdoutBytes < 1 ||
    !Number.isSafeInteger(outputLimits.maxStderrBytes) ||
    outputLimits.maxStderrBytes < 1 ||
    !Number.isSafeInteger(outputLimits.maxTotalBytes) ||
    outputLimits.maxTotalBytes < 1 ||
    timeoutMs > HARD_MAX_COMMAND_TIMEOUT_MS ||
    outputLimits.maxStdoutBytes > HARD_MAX_STDOUT_BYTES ||
    outputLimits.maxStderrBytes > HARD_MAX_STDERR_BYTES ||
    outputLimits.maxTotalBytes > HARD_MAX_TOTAL_OUTPUT_BYTES
  ) {
    throw new CommandPolicyError("Git operation limits must be positive safe integers");
  }
  return { timeoutMs, outputLimits, killGraceMs: defaults.killGraceMs };
}

async function runGit(
  operation: GitOperationResult["operation"],
  args: readonly string[],
  options: GitOperationOptions,
): Promise<GitOperationResult> {
  const cwd = await canonicalWorkspaceRoot(options.workspaceRoot);
  const kind = GIT_OPERATION_KIND[operation];
  const limits = buildLimits(kind, options);
  const executable = options.gitExecutable ?? "git";
  const command: PlannedCommand = {
    executable,
    args,
    cwd,
    env: createSanitizedChildEnv(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    timeoutMs: limits.timeoutMs,
    outputLimits: limits.outputLimits,
    killGraceMs: limits.killGraceMs,
    kind,
  };
  const executor = options.executor ?? new ProcessRunner();
  const result = await executor.run(command);
  return { ...result, operation, argv: [executable, ...args], cwd };
}

export async function git_status(options: GitOperationOptions): Promise<GitOperationResult> {
  return runGit("status", GIT_STATUS_ARGS, options);
}

export async function git_diff(options: GitDiffOptions): Promise<GitOperationResult> {
  const args = options.path === undefined
    ? GIT_DIFF_ARGS
    : [
        ...GIT_DIFF_ARGS.slice(0, GIT_DIFF_ARGS.indexOf("--") + 1),
        literalPathspec(options.path),
        ...SAFE_GIT_PATHSPECS.slice(1),
      ];
  return runGit("diff", args, options);
}

export async function git_log(options: GitLogOptions): Promise<GitOperationResult> {
  const maxCount = clampLogMaxCount(options.maxCount);
  const maxCountIndex = GIT_LOG_ARGS.findIndex((argument) => argument.startsWith("--max-count="));
  if (maxCountIndex < 0) throw new CommandPolicyError("Git log command is missing its count limit");
  const args: string[] = [...GIT_LOG_ARGS];
  args[maxCountIndex] = `--max-count=${maxCount}`;
  return runGit("log", withSafePathspecs(args, options.path), options);
}

export async function git_show(options: GitShowOptions): Promise<GitOperationResult> {
  const commitish = options.commitish ?? "HEAD";
  assertCommitish(commitish);
  if (options.path !== undefined) {
    normalizeRepositoryRelativePath(options.path);
    // Both components are independently restricted above, so the revision
    // object expression cannot introduce flags, traversal, or alternate refs.
    return runGit("show", [...GIT_SHOW_COMMON_ARGS, `${commitish}:${options.path}`], options);
  }
  const commitishIndex = GIT_SHOW_ARGS.indexOf("HEAD");
  if (commitishIndex < 0) throw new CommandPolicyError("Git show command is missing its commit-ish");
  const args: string[] = [...GIT_SHOW_ARGS];
  args[commitishIndex] = commitish;
  return runGit("show", args, options);
}

const gitWriteTails = new Map<string, Promise<void>>();

async function withGitWriteLock<T>(options: GitOperationOptions, operation: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await canonicalWorkspaceRoot(options.workspaceRoot);
  const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const previous = gitWriteTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  gitWriteTails.set(key, tail);
  await previous;
  try {
    return await operation(cwd);
  } finally {
    release();
    if (gitWriteTails.get(key) === tail) gitWriteTails.delete(key);
  }
}

async function indexLockPresent(cwd: string): Promise<boolean> {
  return lstat(path.join(cwd, ".git", "index.lock")).then(() => true).catch(() => false);
}

async function readHead(options: GitOperationOptions): Promise<string | undefined> {
  const result = await runGit("show", GIT_HEAD_ARGS, options);
  if (result.outcome !== "completed" || result.exitCode !== 0 || result.truncated) return undefined;
  const head = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/iu.test(head) ? head : undefined;
}

async function reconcileCommit(
  options: GitOperationOptions,
  original: GitOperationResult,
  beforeHead: string | undefined,
  message: string,
): Promise<GitOperationResult> {
  const afterHead = await readHead(options);
  if (afterHead === beforeHead) {
    return {
      ...original,
      reconciliation: {
        status: "confirmed-not-completed",
        originalOutcome: original.outcome,
        ...(beforeHead ? { beforeHead } : {}),
        ...(afterHead ? { afterHead } : {}),
      },
    };
  }
  if (!afterHead) {
    return {
      ...original,
      reconciliation: {
        status: "indeterminate",
        originalOutcome: original.outcome,
        ...(beforeHead ? { beforeHead } : {}),
      },
    };
  }

  const details = await runGit("show", GIT_HEAD_DETAILS_ARGS, options);
  const [commitHash = "", parents = "", body = ""] = details.stdout.split("\0", 3);
  const parentMatches = beforeHead ? parents.split(" ")[0] === beforeHead : parents.trim() === "";
  const messageMatches = body.trim() === message;
  if (details.outcome === "completed" && details.exitCode === 0 && commitHash === afterHead && parentMatches && messageMatches) {
    return {
      ...original,
      outcome: "completed",
      reconciliation: {
        status: "confirmed-completed",
        originalOutcome: original.outcome,
        ...(beforeHead ? { beforeHead } : {}),
        afterHead,
      },
    };
  }
  return {
    ...original,
    reconciliation: {
      status: "indeterminate",
      originalOutcome: original.outcome,
      ...(beforeHead ? { beforeHead } : {}),
      afterHead,
    },
  };
}

export async function git_init(options: GitOperationOptions): Promise<GitOperationResult> {
  return withGitWriteLock(options, async (cwd) => {
    if (await lstat(path.join(cwd, ".git")).then(() => true).catch(() => false)) {
      throw new CommandPolicyError("Git repository already exists at the workspace root");
    }
    const containing = await runGit("show", ["--no-pager", "--no-optional-locks", "rev-parse", "--git-dir"], options);
    if (containing.outcome === "completed" && containing.exitCode === 0) {
      throw new CommandPolicyError("Workspace is already a Git repository or is inside another Git repository; refusing to initialize it again");
    }
    return runGit("init", GIT_INIT_ARGS, options);
  });
}

export async function git_add(options: GitAddOptions): Promise<GitOperationResult> {
  const paths = normalizeAddPaths(options.paths);
  return withGitWriteLock(options, async (cwd) => {
    const preExisting = await indexLockPresent(cwd);
    if (preExisting) throw new CommandPolicyError("Git index.lock already exists; refusing to start another Git write operation");
    const separator = GIT_ADD_ARGS.indexOf("--");
    if (separator < 0) throw new CommandPolicyError("Git add command is missing its path separator");
    const args = paths
      ? [
          ...GIT_ADD_ARGS.slice(0, separator + 1),
          ...paths.map(literalPathspec),
          ...SAFE_GIT_PATHSPECS.slice(1),
        ]
      : GIT_ADD_ARGS;
    const result = await runGit("add", args, options);
    const presentAfter = await indexLockPresent(cwd);
    return presentAfter ? { ...result, indexLock: { preExisting, presentAfter } } : result;
  });
}

async function assertStagedPathsAreSafe(options: GitOperationOptions): Promise<void> {
  const staged = await runGit("diff", GIT_STAGED_PATHS_ARGS, options);
  if (staged.outcome !== "completed" || staged.exitCode !== 0 || staged.truncated) {
    throw new CommandPolicyError("Could not safely inspect staged Git paths");
  }
  for (const stagedPath of staged.stdout.split("\0").filter(Boolean)) {
    normalizeRepositoryRelativePath(stagedPath);
  }
}

export async function git_commit(options: GitCommitOptions): Promise<GitOperationResult> {
  const message = normalizeCommitMessage(options.message);
  return withGitWriteLock(options, async (cwd) => {
    const preExisting = await indexLockPresent(cwd);
    if (preExisting) throw new CommandPolicyError("Git index.lock already exists; refusing to start another Git write operation");
    await assertStagedPathsAreSafe(options);
    const beforeHead = await readHead(options);

    const hooksDirectory = await mkdtemp(path.join(tmpdir(), "mcp-bridge-git-hooks-"));
    try {
      const args = [
        ...GIT_WRITE_COMMON_ARGS,
        "-c",
        `core.hooksPath=${hooksDirectory}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        message,
      ];
      let result = await runGit("commit", args, options);
      if (["timed-out", "aborted", "output-limit"].includes(result.outcome)) {
        result = await reconcileCommit(options, result, beforeHead, message);
      }
      const presentAfter = await indexLockPresent(cwd);
      return presentAfter ? { ...result, indexLock: { preExisting, presentAfter } } : result;
    } finally {
      await rm(hooksDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export const gitStatus = git_status;
export const gitDiff = git_diff;
export const gitLog = git_log;
export const gitShow = git_show;
export const gitInit = git_init;
export const gitAdd = git_add;
export const gitCommit = git_commit;

export { GIT_STATUS_ARGS, GIT_DIFF_ARGS };
