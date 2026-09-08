import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import type { ProcessTreeTerminator, TerminationReason } from "./types.js";

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(isExited(child)), timeoutMs);
    child.once("close", () => finish(true));
  });
}

function tryKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function terminatePosix(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    if (!isExited(child)) child.kill("SIGTERM");
    return;
  }

  try {
    tryKillGroup(pid, "SIGTERM");
  } catch {
    if (!isExited(child)) child.kill("SIGTERM");
  }
  if (await waitForClose(child, graceMs)) return;

  try {
    tryKillGroup(pid, "SIGKILL");
  } catch {
    if (!isExited(child)) child.kill("SIGKILL");
  }
  await waitForClose(child, graceMs);
}

function taskkillPath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return undefined;
  return path.join(systemRoot, "System32", "taskkill.exe");
}

function runTaskkill(pid: number, timeoutMs: number): Promise<boolean> {
  const executable = taskkillPath();
  if (!executable) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(executable, ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(false);
    }, timeoutMs);
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function terminateWindows(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    if (!isExited(child)) child.kill();
    return;
  }

  // Node does not expose Job Objects. taskkill is a fixed, numeric-PID-only,
  // shell-free best effort fallback; a native Job Object adapter can replace it.
  await runTaskkill(pid, Math.max(250, graceMs));
  if (!isExited(child)) child.kill();
  await waitForClose(child, graceMs);
}

export class DefaultProcessTreeTerminator implements ProcessTreeTerminator {
  public async terminate(child: ChildProcess, _reason: TerminationReason, graceMs: number): Promise<void> {
    if (process.platform === "win32") {
      await terminateWindows(child, graceMs);
      return;
    }
    await terminatePosix(child, graceMs);
  }
}
