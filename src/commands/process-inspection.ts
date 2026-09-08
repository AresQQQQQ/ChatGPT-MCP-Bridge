import path from "node:path";

import { createSanitizedChildEnv, DEFAULT_COMMAND_LIMITS } from "./command-planner.js";
import { ProcessRunner } from "./command-runner.js";
import { CommandPolicyError, type CommandExecutor, type PlannedCommand } from "./types.js";

const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROCESS_RESULTS = 200;

const WINDOWS_PROCESS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$kind = $env:MCP_BRIDGE_PROCESS_QUERY_KIND
$value = $env:MCP_BRIDGE_PROCESS_QUERY_VALUE
if ($kind -eq 'pid') {
  $pidValue = [int]$value
  $items = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $pidValue))
} elseif ($kind -eq 'name') {
  if ($value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'invalid process name' }
  $items = @(Get-CimInstance Win32_Process -Filter ("Name = '" + $value + "'"))
} else {
  throw 'invalid query kind'
}
$results = @()
foreach ($p in $items) {
  $owner = $null
  try {
    $ownerResult = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
    if ($ownerResult.ReturnValue -eq 0 -and $ownerResult.User) {
      $owner = if ($ownerResult.Domain) { $ownerResult.Domain + '\\' + $ownerResult.User } else { $ownerResult.User }
    }
  } catch {}
  $startTime = $null
  try {
    if ($p.CreationDate) { $startTime = $p.CreationDate.ToUniversalTime().ToString('o') }
  } catch {}
  $results += [pscustomobject]@{
    pid = [int]$p.ProcessId
    ppid = [int]$p.ParentProcessId
    name = [string]$p.Name
    exe = if ($p.ExecutablePath) { [string]$p.ExecutablePath } else { $null }
    owner = $owner
    windowsSessionId = [int]$p.SessionId
    startTime = $startTime
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
`;

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new CommandPolicyError("Windows PowerShell location is unavailable");
  }
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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

function parseProcessInfo(value: unknown): ProcessInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandPolicyError("Process inspection returned invalid data");
  }
  const record = value as Record<string, unknown>;
  const pid = Number(record.pid);
  const ppid = Number(record.ppid);
  const windowsSessionId = Number(record.windowsSessionId);
  const name = record.name;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(windowsSessionId) || windowsSessionId < 0 || typeof name !== "string" || !name) {
    throw new CommandPolicyError("Process inspection returned invalid data");
  }
  const exe = record.exe;
  const owner = record.owner;
  const startTime = record.startTime;
  return {
    pid,
    ppid,
    name,
    ...(typeof exe === "string" && exe.length > 0 ? { exe } : {}),
    ...(typeof owner === "string" && owner.length > 0 ? { owner } : {}),
    windowsSessionId,
    ...(typeof startTime === "string" && startTime.length > 0 ? { startTime } : {}),
  };
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
        timer.unref?.();
      });
    }
  }

  private async query(kind: "name" | "pid", value: string, signal?: AbortSignal): Promise<readonly ProcessInfo[]> {
    const limits = DEFAULT_COMMAND_LIMITS["process-inspect"];
    const executable = windowsPowerShellExecutable();
    const env = createSanitizedChildEnv(process.execPath, [path.dirname(executable)]);
    env.MCP_BRIDGE_PROCESS_QUERY_KIND = kind;
    env.MCP_BRIDGE_PROCESS_QUERY_VALUE = value;
    const command: PlannedCommand = {
      executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(WINDOWS_PROCESS_QUERY_SCRIPT),
      ],
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout || "[]") as unknown;
    } catch {
      throw new CommandPolicyError("Process inspection returned invalid JSON");
    }
    if (!Array.isArray(parsed)) throw new CommandPolicyError("Process inspection returned invalid data");
    if (parsed.length > MAX_PROCESS_RESULTS) throw new CommandPolicyError("Process inspection returned too many results");
    return parsed.map(parseProcessInfo);
  }
}
