import type { ChildProcess } from "node:child_process";

import { z } from "zod";

export const PACKAGE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$/;

export const DEFAULT_ALLOWED_PACKAGE_SCRIPTS = ["test", "build", "lint", "typecheck"] as const;

const safePackageScriptNameSchema = z.string().regex(PACKAGE_SCRIPT_NAME_PATTERN, "invalid package script name");

const simpleCommandSchemas = [
  z.object({ kind: z.literal("test"), cwd: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("build"), cwd: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("lint"), cwd: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("typecheck"), cwd: z.string().min(1).optional() }).strict(),
] as const;

export const execCommandRequestSchema = z.discriminatedUnion("kind", [
  ...simpleCommandSchemas,
  z
    .object({ kind: z.literal("package-script"), name: safePackageScriptNameSchema, cwd: z.string().min(1).optional() })
    .strict(),
]);

export type ExecCommandRequest = z.infer<typeof execCommandRequestSchema>;
export type CommandKind = ExecCommandRequest["kind"]
  | "git-status"
  | "git-diff"
  | "git-log"
  | "git-show"
  | "git-init"
  | "git-add"
  | "git-commit"
  | "recipe"
  | "process-inspect";
export type PackageManagerKind = "npm" | "pnpm" | "yarn" | "bun";
export type RuntimeName = "node" | "git" | PackageManagerKind;

export interface ResolvedRuntime {
  readonly kind: RuntimeName;
  readonly executable: string;
  readonly args: readonly string[];
  readonly nodeExecutable: string;
  readonly source: string;
}

export interface RuntimeProbe {
  readonly kind: RuntimeName;
  readonly status: "FOUND" | "NOT FOUND";
  readonly runtime?: ResolvedRuntime;
  readonly detail?: string;
}

export interface PackageManagerConfig {
  readonly kind: PackageManagerKind;
  /** A trusted executable or JavaScript entrypoint supplied by the server, never by an MCP request. */
  readonly executable?: string;
  /** Use this Node executable when executable is a JavaScript entrypoint. */
  readonly nodeExecutable?: string;
  /** Optional fixed arguments inserted before `run <script>`. */
  readonly prefixArgs?: readonly string[];
}

export interface WorkspaceCommandContext {
  /** Trusted workspace root supplied by the host application. */
  readonly workspaceRoot: string;
  /** Exact package-script names the caller has authorized. */
  readonly allowedPackageScripts?: readonly string[];
  readonly packageManager?: PackageManagerConfig;
}

export interface OutputLimits {
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxTotalBytes: number;
}

export interface CommandLimits extends OutputLimits {
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

export interface PlannedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly detached: boolean;
  readonly timeoutMs: number;
  readonly outputLimits: OutputLimits;
  readonly killGraceMs: number;
  readonly kind: CommandKind;
}

export type TerminationReason = "timeout" | "output-limit" | "abort" | "shutdown";

export interface ProcessTreeTerminator {
  terminate(child: ChildProcess, reason: TerminationReason, graceMs: number): Promise<void>;
}

export interface CommandExecutionResult {
  readonly outcome: "completed" | "failed" | "rejected" | "timed-out" | "output-limit" | "aborted";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface CommandExecutor {
  run(command: PlannedCommand, signal?: AbortSignal): Promise<CommandExecutionResult>;
}

export class CommandRequestValidationError extends Error {
  public readonly code = "INVALID_COMMAND_REQUEST";

  public constructor(message: string) {
    super(message);
    this.name = "CommandRequestValidationError";
  }
}

export class CommandPolicyError extends Error {
  public readonly code: string = "COMMAND_POLICY_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

export class RuntimeNotFoundError extends CommandPolicyError {
  public override readonly code = "RUNTIME_NOT_FOUND";
  public readonly runtime: RuntimeName;

  public constructor(runtime: RuntimeName, detail?: string) {
    super(detail ?? `Required runtime '${runtime}' was not found`);
    this.name = "RuntimeNotFoundError";
    this.runtime = runtime;
  }
}

export function parseExecCommandRequest(input: unknown): ExecCommandRequest {
  const parsed = execCommandRequestSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const location = issue?.path.length ? issue.path.join(".") : "request";
  throw new CommandRequestValidationError(`${location}: ${issue?.message ?? "invalid command request"}`);
}
