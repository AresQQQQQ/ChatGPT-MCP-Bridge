import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  CommandPolicyError,
  DEFAULT_ALLOWED_PACKAGE_SCRIPTS,
  PACKAGE_SCRIPT_NAME_PATTERN,
  type CommandKind,
  type CommandLimits,
  type ExecCommandRequest,
  type OutputLimits,
  type PackageManagerConfig,
  type PlannedCommand,
  parseExecCommandRequest,
  type WorkspaceCommandContext,
} from "./types.js";
import {
  createSanitizedChildEnv,
  discoverPackageManager,
  requirePackageManager,
} from "./runtime-discovery.js";

// Kept as a compatibility export for the Git operation layer.
export { createSanitizedChildEnv } from "./runtime-discovery.js";

export const DEFAULT_COMMAND_LIMITS: Readonly<Record<CommandKind, CommandLimits>> = {
  test: {
    timeoutMs: 300_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  build: {
    timeoutMs: 300_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  lint: {
    timeoutMs: 120_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  typecheck: {
    timeoutMs: 120_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  "package-script": {
    timeoutMs: 300_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  "git-status": {
    timeoutMs: 10_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 320 * 1024,
    killGraceMs: 1_000,
  },
  "git-diff": {
    timeoutMs: 30_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 320 * 1024,
    killGraceMs: 1_000,
  },
  "git-log": {
    timeoutMs: 30_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 320 * 1024,
    killGraceMs: 1_000,
  },
  "git-show": {
    timeoutMs: 30_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 320 * 1024,
    killGraceMs: 1_000,
  },
  "git-init": {
    timeoutMs: 30_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
    killGraceMs: 2_000,
  },
  "git-add": {
    timeoutMs: 300_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 128 * 1024,
    maxTotalBytes: 192 * 1024,
    killGraceMs: 5_000,
  },
  "git-commit": {
    timeoutMs: 120_000,
    maxStdoutBytes: 128 * 1024,
    maxStderrBytes: 128 * 1024,
    maxTotalBytes: 256 * 1024,
    killGraceMs: 5_000,
  },
  recipe: {
    timeoutMs: 300_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 256 * 1024,
    maxTotalBytes: 512 * 1024,
    killGraceMs: 2_000,
  },
  "process-inspect": {
    timeoutMs: 15_000,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 64 * 1024,
    maxTotalBytes: 576 * 1024,
    killGraceMs: 1_000,
  },
};

export const HARD_MAX_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
export const HARD_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_STDERR_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_TOTAL_OUTPUT_BYTES = 8 * 1024 * 1024;

const DEFAULT_PACKAGE_MANAGER: PackageManagerConfig = { kind: "npm" };

function mergeLimits(kind: CommandKind, overrides: Partial<CommandLimits> | undefined): CommandLimits {
  const defaults = DEFAULT_COMMAND_LIMITS[kind];
  const result: CommandLimits = {
    timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
    maxStdoutBytes: overrides?.maxStdoutBytes ?? defaults.maxStdoutBytes,
    maxStderrBytes: overrides?.maxStderrBytes ?? defaults.maxStderrBytes,
    maxTotalBytes: overrides?.maxTotalBytes ?? defaults.maxTotalBytes,
    killGraceMs: overrides?.killGraceMs ?? defaults.killGraceMs,
  };
  if (
    !Number.isSafeInteger(result.timeoutMs) ||
    result.timeoutMs < 1 ||
    !Number.isSafeInteger(result.killGraceMs) ||
    result.killGraceMs < 1 ||
    !Number.isSafeInteger(result.maxStdoutBytes) ||
    result.maxStdoutBytes < 1 ||
    !Number.isSafeInteger(result.maxStderrBytes) ||
    result.maxStderrBytes < 1 ||
    !Number.isSafeInteger(result.maxTotalBytes) ||
    result.maxTotalBytes < 1 ||
    result.timeoutMs > HARD_MAX_COMMAND_TIMEOUT_MS ||
    result.maxStdoutBytes > HARD_MAX_STDOUT_BYTES ||
    result.maxStderrBytes > HARD_MAX_STDERR_BYTES ||
    result.maxTotalBytes > HARD_MAX_TOTAL_OUTPUT_BYTES
  ) {
    throw new CommandPolicyError("Command limits must be positive safe integers");
  }
  return result;
}

export function outputLimitsFor(kind: CommandKind, overrides?: Partial<CommandLimits>): OutputLimits {
  const limits = mergeLimits(kind, overrides);
  return {
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    maxTotalBytes: limits.maxTotalBytes,
  };
}

function assertPathIsRelative(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new CommandPolicyError(`${label} must be a relative path inside the workspace`);
  }
  if (process.platform !== "win32" && value.includes("\\")) {
    throw new CommandPolicyError(`${label} contains an unsupported path separator`);
  }
  const segments = value.split(/[\\/]/u);
  if (
    value !== "." &&
    (/[\\/]{2}/u.test(value) || segments.some((segment) => segment === "." || segment === ".." || segment.length === 0))
  ) {
    throw new CommandPolicyError(`${label} contains traversal or ambiguous separators`);
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CommandPolicyError("cwd is outside the configured workspace");
  }
}

export async function resolveCommandCwd(workspaceRoot: string, requestedRelative?: string): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("workspace root is not a directory");
  } catch {
    throw new CommandPolicyError("workspace root is unavailable");
  }

  if (requestedRelative === undefined) return canonicalRoot;
  assertPathIsRelative(requestedRelative, "cwd");
  const lexicalCandidate = path.resolve(canonicalRoot, requestedRelative);
  assertContained(canonicalRoot, lexicalCandidate);

  try {
    const canonicalCandidate = await realpath(lexicalCandidate);
    if (!(await stat(canonicalCandidate)).isDirectory()) throw new Error("cwd is not a directory");
    assertContained(canonicalRoot, canonicalCandidate);
    return canonicalCandidate;
  } catch (error) {
    if (error instanceof CommandPolicyError) throw error;
    throw new CommandPolicyError("cwd is unavailable");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as unknown;
  } catch {
    throw new CommandPolicyError("package.json is missing or invalid");
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    throw new CommandPolicyError("package.json does not contain a scripts object");
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(parsed.scripts)) {
    if (typeof command === "string") scripts[name] = command;
  }
  return scripts;
}

export interface CommandPlannerOptions {
  readonly limits?: Partial<Record<CommandKind, Partial<CommandLimits>>>;
}

export class CommandPlanner {
  private readonly options: CommandPlannerOptions;

  public constructor(options: CommandPlannerOptions = {}) {
    this.options = options;
  }

  public async plan(input: unknown, workspace: WorkspaceCommandContext): Promise<PlannedCommand> {
    const request = parseExecCommandRequest(input);
    const cwd = await resolveCommandCwd(workspace.workspaceRoot, request.cwd);

    const scriptName = request.kind === "package-script" ? request.name : request.kind;
    if (!PACKAGE_SCRIPT_NAME_PATTERN.test(scriptName)) {
      throw new CommandPolicyError("invalid package script name");
    }

    const allowlist = workspace.allowedPackageScripts ?? DEFAULT_ALLOWED_PACKAGE_SCRIPTS;
    if (!allowlist.includes(scriptName)) {
      throw new CommandPolicyError(`package script '${scriptName}' is not allowed`);
    }

    const scripts = await readPackageScripts(cwd);
    if (!Object.hasOwn(scripts, scriptName)) {
      throw new CommandPolicyError(`package script '${scriptName}' is not defined`);
    }

    const manager = workspace.packageManager ?? { ...DEFAULT_PACKAGE_MANAGER, kind: await discoverPackageManager(cwd) };
    const runtime = await requirePackageManager(manager, workspace.workspaceRoot);
    const prefixArgs = manager.prefixArgs ?? [];
    const runtimeDirectories = [
      path.dirname(runtime.executable),
      ...(path.isAbsolute(runtime.source) ? [path.dirname(runtime.source)] : []),
      ...runtime.args.filter((value) => path.isAbsolute(value)).map((value) => path.dirname(value)),
    ];
    if (prefixArgs.some((arg) => arg.includes("\0") || arg.includes("\r") || arg.includes("\n"))) {
      throw new CommandPolicyError("package manager prefix arguments contain control characters");
    }
    const kind: CommandKind = request.kind;
    const limits = mergeLimits(kind, this.options.limits?.[kind]);
    return {
      executable: runtime.executable,
      args: [...runtime.args, ...prefixArgs, "run", scriptName],
      cwd,
      env: createSanitizedChildEnv(runtime.nodeExecutable, runtimeDirectories),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      timeoutMs: limits.timeoutMs,
      outputLimits: outputLimitsFor(kind, limits),
      killGraceMs: limits.killGraceMs,
      kind,
    };
  }
}
