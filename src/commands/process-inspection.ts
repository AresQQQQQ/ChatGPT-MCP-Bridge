import path from "node:path";

import { createSanitizedChildEnv, DEFAULT_COMMAND_LIMITS } from "./command-planner.js";
import { ProcessRunner } from "./command-runner.js";
import { CommandPolicyError, type CommandExecutor, type PlannedCommand } from "./types.js";

const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROCESS_RESULTS = 200;

function windowsTasklistExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new CommandPolicyError("Windows tasklist location is unavailable");
  }
  return path.join(systemRoot, "System32", "tasklist.exe");
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' ) {
      if (quoted && line[index + 1] === '"' ) { field += '"' ; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field); field = "";
    } else { field += char; }
  }
  fields.push(field);
  return fields;
}

export function parseTaskListCsv(output: string): readonly ProcessInfo[] {
  const results: ProcessInfo[] = [];
  for (const line of output.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value.startsWith('"'))) {
    const [name, pidText, , sessionText] = parseCsvRow(line);
    const pid = Number(pidText);
    const sessionId = Number(sessionText);
    if (!name || !Number.isSafeInteger(pid) || pid <= 0) continue;
    results.push({
      pid,
      // tasklist does not report parent PID, executable path, or start time.
      ppid: 0,
      name,
      windowsSessionId: Number.isSafeInteger(sessionId) && sessionId >= 0 ? sessionId : 0,
    });
  }
  return results;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly exe?: string;
  readonly owner?: string;
  readonly windowsSessionId: number;
  readonly startTime?: string;
}

export class ProcessInspector {
  public constructor(private readonly executor: CommandExecutor = new ProcessRunner()) {}

  public async findByName(name: string, signal?: AbortSignal): Promise<readonly ProcessInfo[]> {
    if (process.platform !== "win32") throw new CommandPolicyError("Process inspection is currently supported only on Windows");
    if (!PROCESS_NAME_PATTERN.test(name)) throw new CommandPolicyError("Process name is invalid");
    return this.query("name", name, signal);
  }

  public async inspect(pid: number, signal?: AbortSignal): Promise<ProcessInfo | undefined> {
    if (process.platform !== "win32") throw new CommandPolicyError("Process inspection is currently supported only on Windows");
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new CommandPolicyError("Process id is invalid");
    const results = await this.query("pid", String(pid), signal);
    if (results.length > 1) throw new CommandPolicyError("Process inspection returned ambiguous data");
    return results[0];
  }

  public async waitForExit(
    pid: number,
    timeoutMs = 30_000,
    pollMs = 500,
    signal?: AbortSignal,
  ): Promise<{ readonly pid: number; readonly exited: boolean; readonly elapsedMs: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new CommandPolicyError("Process wait timeout is invalid");
    }
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 5_000) {
      throw new CommandPolicyError("Process wait interval is invalid");
    }
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw new CommandPolicyError("Process wait was aborted");
      if (!await this.inspect(pid, signal)) return { pid, exited: true, elapsedMs: Date.now() - startedAt };
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) return { pid, exited: false, elapsedMs: elapsed };
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(pollMs, timeoutMs - elapsed));
        const onAbort = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new CommandPolicyError("Process wait was aborted"));
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        // Keep this timer referenced: callers await waitForExit and need a guaranteed resolution.
      });
    }
  }

  private async query(kind: "name" | "pid", value: string, signal?: AbortSignal): Promise<readonly ProcessInfo[]> {
    const limits = DEFAULT_COMMAND_LIMITS["process-inspect"];
    const executable = windowsTasklistExecutable();
    const env = createSanitizedChildEnv(process.execPath, [path.dirname(executable)]);
    const filter = kind === "pid"
      ? "PID eq " + value
      : "IMAGENAME eq " + (value.toLowerCase().endsWith(".exe") ? value : value + ".exe");
    const command: PlannedCommand = {
      executable,
      args: ["/FO", "CSV", "/NH", "/FI", filter],
      cwd: path.dirname(executable),
      env,
      shell: false,
      windowsHide: true,
      detached: false,
      timeoutMs: limits.timeoutMs,
      outputLimits: {
        maxStdoutBytes: limits.maxStdoutBytes,
        maxStderrBytes: limits.maxStderrBytes,
        maxTotalBytes: limits.maxTotalBytes,
      },
      killGraceMs: limits.killGraceMs,
      kind: "process-inspect",
    };
    const result = await this.executor.run(command, signal);
    if (result.outcome !== "completed" || result.exitCode !== 0 || result.truncated) {
      throw new CommandPolicyError("Process inspection failed");
    }
    const parsed = parseTaskListCsv(result.stdout);
    if (parsed.length > MAX_PROCESS_RESULTS) throw new CommandPolicyError("Process inspection returned too many results");
    return parsed;
  }
}

