#!/usr/bin/env node

import { constants } from "node:fs";
import { access, chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONFIG_FILE,
  createAuthToken,
  configFileTemplate,
  isNodeError,
  isWorkspaceWritableMode,
  loadConfig,
  type BridgeConfig,
} from "./config.js";
import { buildHttpSecurityPolicy } from "./http/auth.js";
import {
  discoverRequiredPackageManagers,
  PACKAGE_MANAGER_KINDS,
  probeRuntime,
  type RuntimeName,
} from "./commands/index.js";
import { WorkspaceRegistry } from "./workspaces/workspace-registry.js";
import { BridgeController, listenBridge } from "./control/bridge-controller.js";
import { launchLocalControlUi } from "./ui/windows-console.js";

interface CliOptions {
  configPath: string;
  host: string | undefined;
  port: number | undefined;
  force: boolean;
}

function parseOptions(args: readonly string[]): CliOptions {
  let configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  let host: string | undefined;
  let port: number | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      const value = args[++index];
      if (!value) throw new Error("--config requires a path");
      configPath = path.resolve(value);
    } else if (argument === "--host") {
      const value = args[++index];
      if (!value) throw new Error("--host requires a value");
      host = value;
    } else if (argument === "--port") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error("--port requires a number");
      port = Number(value);
    } else if (argument === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { configPath, host, port, force };
}

function withRuntimeOverrides(config: BridgeConfig, options: CliOptions): BridgeConfig {
  return {
    ...config,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  };
}

async function writeConfigSecure(configPath: string, content: string, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (!overwrite) {
    try {
      const handle = await open(configPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      await chmod(configPath, 0o600);
      return;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Config already exists: ${configPath} (use --force to replace it)`);
      }
      throw error;
    }
  }

  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

async function init(options: CliOptions): Promise<number> {
  const token = createAuthToken();
  await writeConfigSecure(options.configPath, configFileTemplate(token), options.force);
  console.log(`Created ${options.configPath}`);
  console.log(`Generated auth token (shown once; store it securely): ${token}`);
  return 0;
}

function nodeMajorVersion(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

async function checkWorkspaceRoot(workspace: BridgeConfig["workspaces"][number], maxReadBytes: number): Promise<void> {
  const registry = await WorkspaceRegistry.create({ workspaces: [workspace], maxReadBytes });
  const opened = await registry.openWorkspace(workspace.id);
  const requiredAccess = constants.R_OK | constants.X_OK | (isWorkspaceWritableMode(opened.mode) ? constants.W_OK : 0);
  await access(opened.root, requiredAccess);
}

async function doctor(options: CliOptions): Promise<number> {
  let healthy = true;

  let config: BridgeConfig;
  try {
    config = withRuntimeOverrides(await loadConfig(options.configPath), options);
    console.log(`OK config: ${config.configPath}`);
  } catch (error) {
    healthy = false;
    console.error(`FAIL config: ${error instanceof Error ? error.message : "unavailable"}`);
    return 1;
  }

  const runtimeKinds: readonly RuntimeName[] = ["node", "git", ...PACKAGE_MANAGER_KINDS];
  const runtimeProbes = await Promise.all(runtimeKinds.map((kind) => probeRuntime(kind)));
  const runtimeByKind = new Map(runtimeProbes.map((probe) => [probe.kind, probe]));
  const nodeProbe = runtimeByKind.get("node");
  if (nodeProbe?.status === "FOUND" && nodeMajorVersion() >= 22) {
    console.log(`OK Node.js: FOUND (${process.version})`);
  } else {
    healthy = false;
    const versionNote = nodeMajorVersion() < 22 ? `; Node.js 22 or newer is required (${process.version})` : "";
    console.error(`FAIL Node.js: NOT FOUND${versionNote}`);
  }

  const gitProbe = runtimeByKind.get("git");
  if (gitProbe?.status === "FOUND") {
    console.log("OK Git: FOUND");
  } else {
    healthy = false;
    console.error(`FAIL Git: NOT FOUND${gitProbe?.detail ? ` (${gitProbe.detail})` : ""}`);
  }

  const requiredManagers = await discoverRequiredPackageManagers(config.workspaces);
  for (const kind of PACKAGE_MANAGER_KINDS) {
    const requiredBy = requiredManagers.get(kind);
    const probe = runtimeByKind.get(kind);
    if (!requiredBy) {
      console.log(`OK ${kind}: NOT REQUIRED`);
    } else if (probe?.status === "FOUND") {
      console.log(`OK ${kind}: FOUND (required by ${requiredBy.join(", ")})`);
    } else {
      healthy = false;
      console.error(`FAIL ${kind}: NOT FOUND (required by ${requiredBy.join(", ")})`);
    }
  }

  try {
    const policy = buildHttpSecurityPolicy(config);
    const binding = policy.requireAuth ? "authentication required" : "loopback / authentication optional";
    console.log(`OK auth/listening policy: ${binding}`);
  } catch (error) {
    healthy = false;
    console.error(`FAIL auth/listening policy: ${error instanceof Error ? error.message : "invalid policy"}`);
  }

  for (const workspace of config.workspaces) {
    try {
      await checkWorkspaceRoot(workspace, config.maxReadBytes);
      console.log(`OK root '${workspace.id}': policy and permissions valid`);
    } catch {
      healthy = false;
      console.error(`FAIL root '${workspace.id}': unavailable or unreadable`);
    }
  }

  return healthy ? 0 : 1;
}

async function serve(options: CliOptions): Promise<number> {
  const config = withRuntimeOverrides(await loadConfig(options.configPath), options);
  const bridgeServer = await listenBridge(config);
  console.log(`MCP Bridge listening at ${bridgeServer.url}`);

  const shutdown = async () => bridgeServer.close();
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  return 0;
}

async function ui(options: CliOptions): Promise<number> {
  const controlUi = await launchLocalControlUi(options.configPath);
  console.log("MCP Bridge 本地控制台已打开。关闭窗口或按 Ctrl+C 可退出控制台并停止其管理的 Bridge/Tunnel。");
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await controlUi.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return 0;
}

async function start(options: CliOptions): Promise<number> {
  let stopping = false;
  const controller = new BridgeController(
    {
      configPath: options.configPath,
      onUnexpectedTunnelExit: (message) => {
        if (stopping) return;
        console.error(message);
        process.exitCode = 1;
      },
    },
    { loadConfig: async (configPath) => withRuntimeOverrides(await loadConfig(configPath), options) },
  );
  await controller.start();
  for (const entry of controller.getLogs()) {
    const writer = entry.stream === "stderr" ? console.error : console.log;
    writer(entry.message);
  }
  console.log("Press Ctrl+C to stop both services.");

  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await controller.stop();
    process.exitCode = exitCode;
  };
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  return 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const [command = "help", ...commandArgs] = args;
  const options = parseOptions(commandArgs);
  if (command === "init") return init(options);
  if (command === "doctor") return doctor(options);
  if (command === "serve") return serve(options);
  if (command === "start") return start(options);
  if (command === "ui") return ui(options);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("Usage: mcp-bridge <init|serve|start|ui|doctor> [--config path] [--host host] [--port port]");
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exitCode = code,
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
