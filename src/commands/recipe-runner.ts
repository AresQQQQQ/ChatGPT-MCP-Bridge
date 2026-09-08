import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRecipeConfig } from "../config.js";
import { createSanitizedChildEnv, DEFAULT_COMMAND_LIMITS, HARD_MAX_COMMAND_TIMEOUT_MS } from "./command-planner.js";
import { ProcessRunner } from "./command-runner.js";
import { CommandPolicyError, type CommandExecutionResult, type CommandExecutor, type PlannedCommand } from "./types.js";
import { resolveCommandCwd } from "./command-planner.js";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com"] as const;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error("workspace root is not a directory");
    return canonical;
  } catch {
    throw new CommandPolicyError("workspace root is unavailable");
  }
}

async function usableExecutable(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return undefined;
    if (process.platform !== "win32") await access(canonical, constants.X_OK);
    if (process.platform === "win32" && !WINDOWS_EXECUTABLE_EXTENSIONS.includes(path.extname(canonical).toLowerCase() as ".exe" | ".com")) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function pathEntries(): readonly string[] {
  const raw = process.platform === "win32"
    ? (process.env.Path ?? process.env.PATH ?? "")
    : (process.env.PATH ?? process.env.Path ?? "");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [path.dirname(process.execPath), ...raw.split(path.delimiter)]) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const normalized = path.normalize(entry);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

async function resolveRecipeExecutable(executable: string, workspaceRoot: string): Promise<string> {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : pathEntries().flatMap((directory) => {
        if (process.platform !== "win32") return [path.join(directory, executable)];
        const extension = path.extname(executable).toLowerCase();
        return extension
          ? [path.join(directory, executable)]
          : WINDOWS_EXECUTABLE_EXTENSIONS.map((suffix) => path.join(directory, `${executable}${suffix}`));
      });

  for (const candidate of candidates) {
    const resolved = await usableExecutable(candidate);
    if (!resolved) continue;
    // A recipe definition is trusted local configuration, but its executable
    // must not be replaceable through ordinary workspace file writes.
    if (isContained(workspaceRoot, resolved)) {
      throw new CommandPolicyError("configured recipe executable must be outside the writable workspace");
    }
    return resolved;
  }
  throw new CommandPolicyError(`configured recipe executable '${executable}' was not found`);
}

function assertRecipeArguments(args: readonly string[]): void {
  if (args.length > 128) throw new CommandPolicyError("recipe has too many arguments");
  let total = 0;
  for (const argument of args) {
    if (/[\u0000\r\n]/u.test(argument)) throw new CommandPolicyError("recipe argument contains control characters");
    total += argument.length;
  }
  if (total > 64 * 1024) throw new CommandPolicyError("recipe arguments exceed the safe size limit");
}

export interface RecipeExecutionResult extends CommandExecutionResult {
  readonly recipeId: string;
  readonly cwd: string;
}

export class RecipeRunner {
  public constructor(private readonly executor: CommandExecutor = new ProcessRunner()) {}

  public async run(
    recipeId: string,
    recipe: WorkspaceRecipeConfig,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<RecipeExecutionResult> {
    const canonicalRoot = await canonicalWorkspaceRoot(workspaceRoot);
    const cwd = await resolveCommandCwd(canonicalRoot, recipe.cwd);
    const executable = await resolveRecipeExecutable(recipe.executable, canonicalRoot);
    assertRecipeArguments(recipe.args);

    const defaults = DEFAULT_COMMAND_LIMITS.recipe;
    const timeoutMs = recipe.timeoutMs ?? defaults.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARD_MAX_COMMAND_TIMEOUT_MS) {
      throw new CommandPolicyError("recipe timeout is invalid");
    }

    const command: PlannedCommand = {
      executable,
      args: [...recipe.args],
      cwd,
      env: createSanitizedChildEnv(process.execPath, [path.dirname(executable)]),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      timeoutMs,
      outputLimits: {
        maxStdoutBytes: defaults.maxStdoutBytes,
        maxStderrBytes: defaults.maxStderrBytes,
        maxTotalBytes: defaults.maxTotalBytes,
      },
      killGraceMs: defaults.killGraceMs,
      kind: "recipe",
    };
    const result = await this.executor.run(command, signal);
    return { ...result, recipeId, cwd };
  }
}
