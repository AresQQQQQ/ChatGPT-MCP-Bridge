import path from "node:path";

import {
  DEFAULT_COMMAND_LIMITS,
  HARD_MAX_COMMAND_TIMEOUT_MS,
  resolveCommandCwd,
} from "./command-planner.js";
import { ProcessRunner } from "./command-runner.js";
import { CommandPolicyError, type CommandExecutionResult, type PlannedCommand } from "./types.js";

const SECRET_ENV_NAME_PATTERNS = [
  /^CONTROL_PLANE_API_KEY$/iu,
  /^MCP_BRIDGE_.*(?:TOKEN|SECRET|KEY)$/iu,
  /^BRIDGE_.*(?:TOKEN|SECRET|KEY)$/iu,
  /^TUNNEL_.*(?:TOKEN|SECRET|KEY)$/iu,
  /^OPENAI_SECURE_MCP_.*(?:TOKEN|SECRET|KEY)$/iu,
] as const;

export type TrustedDevRequest =
  | {
      readonly type: "exec";
      readonly executable: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly type: "shell";
      readonly shell: "cmd" | "powershell";
      readonly command: string;
      readonly cwd?: string;
      readonly timeoutMs?: number;
    };

function assertPlainText(value: string, label: string, maxChars: number): void {
  if (!value || value.length > maxChars || /\u0000/u.test(value)) {
    throw new CommandPolicyError(`${label} is invalid`);
  }
}

function trustedDeveloperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function timeoutFor(requested: number | undefined): number {
  const value = requested ?? DEFAULT_COMMAND_LIMITS.recipe.timeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_COMMAND_TIMEOUT_MS) {
    throw new CommandPolicyError("timeoutMs is invalid");
  }
  return value;
}

function planBase(executable: string, args: readonly string[], cwd: string, timeoutMs: number): PlannedCommand {
  return {
    executable,
    args: [...args],
    cwd,
    env: trustedDeveloperEnvironment(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    timeoutMs,
    outputLimits: {
      maxStdoutBytes: DEFAULT_COMMAND_LIMITS.recipe.maxStdoutBytes,
      maxStderrBytes: DEFAULT_COMMAND_LIMITS.recipe.maxStderrBytes,
      maxTotalBytes: DEFAULT_COMMAND_LIMITS.recipe.maxTotalBytes,
    },
    killGraceMs: DEFAULT_COMMAND_LIMITS.recipe.killGraceMs,
    kind: "recipe",
  };
}

export class TrustedDevCommandRunner {
  public constructor(private readonly runner = new ProcessRunner()) {}

  public async run(
    request: TrustedDevRequest,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult> {
    const cwd = await resolveCommandCwd(workspaceRoot, request.cwd);
    const timeoutMs = timeoutFor(request.timeoutMs);

    if (request.type === "exec") {
      assertPlainText(request.executable, "executable", 4096);
      const args = request.args ?? [];
      if (args.length > 256) throw new CommandPolicyError("too many arguments");
      let total = 0;
      for (const argument of args) {
        if (argument.length > 16 * 1024 || /\u0000/u.test(argument)) throw new CommandPolicyError("argument is invalid");
        total += argument.length;
      }
      if (total > 128 * 1024) throw new CommandPolicyError("arguments exceed the safe size limit");
      return this.runner.run(planBase(request.executable, args, cwd, timeoutMs), signal);
    }

    assertPlainText(request.command, "command", 128 * 1024);
    if (process.platform !== "win32") {
      throw new CommandPolicyError("cmd and PowerShell trusted developer execution is supported on Windows only");
    }
    if (request.shell === "cmd") {
      const executable = process.env.ComSpec || "cmd.exe";
      return this.runner.run(planBase(executable, ["/d", "/s", "/c", request.command], cwd, timeoutMs), signal);
    }
    return this.runner.run(planBase("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", request.command], cwd, timeoutMs), signal);
  }
}
