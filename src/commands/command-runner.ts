import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { performance } from "node:perf_hooks";

import { CommandPlanner, type CommandPlannerOptions } from "./command-planner.js";
import { DefaultProcessTreeTerminator } from "./process-tree.js";
import {
  type CommandExecutionResult,
  type CommandExecutor,
  type ExecCommandRequest,
  type PlannedCommand,
  type ProcessTreeTerminator,
  type TerminationReason,
  type WorkspaceCommandContext,
} from "./types.js";

export interface ChildProcessSpawner {
  (file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

export interface ProcessRunnerOptions {
  readonly terminator?: ProcessTreeTerminator;
  readonly spawnProcess?: ChildProcessSpawner;
}

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  public bytes = 0;
  public truncated = false;

  public append(chunk: Buffer, allowedBytes: number): boolean {
    if (allowedBytes <= 0) {
      this.truncated = true;
      return chunk.length > 0;
    }
    const accepted = Math.min(chunk.length, allowedBytes);
    if (accepted > 0) {
      this.chunks.push(chunk.subarray(0, accepted));
      this.bytes += accepted;
    }
    if (accepted < chunk.length) this.truncated = true;
    return accepted < chunk.length;
  }

  public text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function now(): number {
  return performance.now();
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processErrorCode(error: unknown): string {
  return isErrnoError(error) && error.code === "ENOENT" ? "RUNTIME_NOT_FOUND" : "PROCESS_FAILED";
}

function processErrorMessage(error: unknown, executable: string): string {
  if (isErrnoError(error) && error.code === "ENOENT") {
    return `Runtime executable '${executable}' was not found`;
  }
  return error instanceof Error ? error.message : "Process failed";
}

function emptyResult(
  startedAt: number,
  outcome: CommandExecutionResult["outcome"],
  error?: unknown,
  executable?: string,
): CommandExecutionResult {
  return {
    outcome,
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    ...(error !== undefined && executable
      ? { errorCode: processErrorCode(error), errorMessage: processErrorMessage(error, executable) }
      : {}),
  };
}

export class ProcessRunner implements CommandExecutor {
  private readonly terminator: ProcessTreeTerminator;
  private readonly spawnProcess: ChildProcessSpawner;

  public constructor(options: ProcessRunnerOptions = {}) {
    this.terminator = options.terminator ?? new DefaultProcessTreeTerminator();
    this.spawnProcess = options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
  }

  public async run(command: PlannedCommand, signal?: AbortSignal): Promise<CommandExecutionResult> {
    const startedAt = now();
    if (signal?.aborted) return emptyResult(startedAt, "aborted");

    let child: ChildProcess;
    try {
      child = this.spawnProcess(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...command.env },
        shell: false,
        windowsHide: true,
        detached: command.detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return emptyResult(startedAt, "failed", error, command.executable);
    }

    const stdout = new OutputCollector();
    const stderr = new OutputCollector();
    let totalBytes = 0;
    let outputLimit = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | undefined;
    let terminationPromise: Promise<void> | undefined;
    let timeout: NodeJS.Timeout | undefined;

    const requestTermination = (reason: TerminationReason): void => {
      if (terminationPromise) return;
      terminationPromise = this.terminator.terminate(child, reason, command.killGraceMs).catch((error: unknown) => {
        if (error instanceof Error) {
          spawnError = spawnError ?? error;
        }
      });
    };

    const appendOutput = (collector: OutputCollector, chunk: Buffer, maxBytes: number): void => {
      const remainingTotal = Math.max(0, command.outputLimits.maxTotalBytes - totalBytes);
      const acceptedAllowance = Math.min(Math.max(0, maxBytes - collector.bytes), remainingTotal);
      const overflow = collector.append(chunk, acceptedAllowance);
      totalBytes += Math.min(chunk.length, acceptedAllowance);
      if (overflow || collector.truncated || totalBytes >= command.outputLimits.maxTotalBytes && chunk.length > acceptedAllowance) {
        outputLimit = true;
        requestTermination("output-limit");
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendOutput(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), command.outputLimits.maxStdoutBytes);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendOutput(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), command.outputLimits.maxStderrBytes);
    });
    child.once("error", (error: Error) => {
      spawnError = error;
    });

    const onAbort = (): void => {
      aborted = true;
      requestTermination("abort");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      timedOut = true;
      requestTermination("timeout");
    }, command.timeoutMs);

    return new Promise<CommandExecutionResult>((resolve) => {
      child.once("close", (exitCode: number | null, closeSignal: NodeJS.Signals | null) => {
        void (async () => {
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          if (terminationPromise) await terminationPromise;

          let outcome: CommandExecutionResult["outcome"] = "completed";
          if (timedOut) outcome = "timed-out";
          else if (outputLimit) outcome = "output-limit";
          else if (aborted) outcome = "aborted";
          else if (spawnError || exitCode !== 0) outcome = "failed";

          resolve({
            outcome,
            exitCode,
            signal: closeSignal,
            durationMs: Math.max(0, Math.round(now() - startedAt)),
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
            truncated: stdout.truncated || stderr.truncated,
            ...(spawnError
              ? {
                  errorCode: processErrorCode(spawnError),
                  errorMessage: processErrorMessage(spawnError, command.executable),
                }
              : {}),
          });
        })();
      });
    });
  }
}

export interface ControlledCommandRunnerOptions extends ProcessRunnerOptions, CommandPlannerOptions {}

export class ControlledCommandRunner {
  private readonly planner: CommandPlanner;
  private readonly executor: CommandExecutor;

  public constructor(options: ControlledCommandRunnerOptions = {}, executor?: CommandExecutor) {
    this.planner = new CommandPlanner(options);
    this.executor = executor ?? new ProcessRunner(options);
  }

  public async run(
    input: unknown,
    workspace: WorkspaceCommandContext,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult> {
    const planned = await this.planner.plan(input, workspace);
    return this.executor.run(planned, signal);
  }
}

export async function exec_command(
  input: ExecCommandRequest | unknown,
  workspace: WorkspaceCommandContext,
  options: ControlledCommandRunnerOptions = {},
  signal?: AbortSignal,
): Promise<CommandExecutionResult> {
  return new ControlledCommandRunner(options).run(input, workspace, signal);
}

export const execCommand = exec_command;
