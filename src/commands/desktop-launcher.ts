import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { resolveCommandCwd } from "./command-planner.js";
import { CommandPolicyError } from "./types.js";

export interface DesktopLaunchRequest {
  readonly target: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface DesktopLaunchResult {
  readonly launchId: string;
  readonly pid: number;
  readonly startedAt: string;
}

function assertPlainText(value: string, label: string, maxChars: number): void {
  if (!value || value.length > maxChars || /\u0000/u.test(value)) throw new CommandPolicyError(`${label} is invalid`);
}

function quoteCmdArgument(value: string): string {
  if (!/[\s"&|<>^()]/u.test(value)) return value;
  return `"${value.replace(/([\\]*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function normalizedTarget(target: string, cwd: string): string {
  if (path.isAbsolute(target)) return target;
  if (target.includes("/") || target.includes("\\")) return path.resolve(cwd, target);
  return target;
}

function spawnDesktop(target: string, args: readonly string[], cwd: string): ChildProcess {
  const extension = path.extname(target).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const command = [quoteCmdArgument(target), ...args.map(quoteCmdArgument)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
      env: { ...process.env },
      shell: false,
      windowsHide: false,
      detached: false,
      stdio: "ignore",
    });
  }
  return spawn(target, args, {
    cwd,
    env: { ...process.env },
    shell: false,
    windowsHide: false,
    detached: false,
    stdio: "ignore",
  });
}

export class DesktopAppLauncher {
  public async launch(request: DesktopLaunchRequest, workspaceRoot: string): Promise<DesktopLaunchResult> {
    assertPlainText(request.target, "target", 4096);
    const args = request.args ?? [];
    if (args.length > 256) throw new CommandPolicyError("too many arguments");
    for (const argument of args) {
      if (argument.length > 16 * 1024 || /\u0000/u.test(argument)) throw new CommandPolicyError("argument is invalid");
    }
    const cwd = await resolveCommandCwd(workspaceRoot, request.cwd);
    const target = normalizedTarget(request.target, cwd);
    let child: ChildProcess;
    try {
      child = spawnDesktop(target, args, cwd);
    } catch (error) {
      throw new CommandPolicyError(error instanceof Error ? error.message : "Desktop launch failed");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(new CommandPolicyError(error.message));
      };
      child.once("error", onError);
      setImmediate(() => {
        if (settled) return;
        settled = true;
        child.removeListener("error", onError);
        resolve();
      });
    });
    if (!child.pid) throw new CommandPolicyError("Desktop process did not report a PID");
    child.unref();
    return { launchId: randomUUID(), pid: child.pid, startedAt: new Date().toISOString() };
  }
}
