import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
export interface NativeMacUi { close(): Promise<void> }

async function launchNativeMacUiMode(configPath: string, mode: "console" | "setup"): Promise<NativeMacUi> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("原生 Mac 控制台目前支持 macOS Apple Silicon。");
  const executable = path.join(root, ".mcp-bridge-state/ChatGPT MCP Bridge.app/Contents/MacOS/BridgeControl");
  const host = path.join(root, "dist/ui/mac-app-host.js");
  try {
    if (!(await lstat(executable)).isFile() || !(await lstat(host)).isFile()) throw new Error("Invalid build artifact");
    await access(executable, constants.X_OK);
    await access(host, constants.R_OK);
  } catch {
    throw new Error("Mac 控制台尚未构建，请先运行 pnpm run ui:build。");
  }
  const child: ChildProcess = spawn(executable, [], { shell: false, stdio: "ignore", env: { ...process.env, BRIDGE_UI_CONFIG: path.resolve(configPath), BRIDGE_UI_MODE: mode } });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  return {
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

export function launchNativeMacUi(configPath: string): Promise<NativeMacUi> {
  return launchNativeMacUiMode(configPath, "console");
}

export function launchNativeMacSetupUi(configPath: string): Promise<NativeMacUi> {
  return launchNativeMacUiMode(configPath, "setup");
}