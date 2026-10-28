import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let configPath = path.join(root, "mcp-bridge.json");
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--config") {
    const value = args[++i];
    if (!value) { console.error("--config requires a path"); process.exit(2); }
    configPath = path.resolve(value);
  } else {
    console.error("Unknown setup option: " + args[i]);
    process.exit(2);
  }
}

function fileStat(file) {
  try { return statSync(file); } catch { return undefined; }
}

function needsMacUiBuild() {
  const appExecutable = path.join(root, ".mcp-bridge-state", "ChatGPT MCP Bridge.app", "Contents", "MacOS", "BridgeControl");
  const nativeSource = path.join(root, "src", "ui", "macos", "BridgeControlApp.swift");
  const nativeInfo = fileStat(appExecutable);
  const swiftInfo = fileStat(nativeSource);
  if (!nativeInfo || !swiftInfo || swiftInfo.mtimeMs > nativeInfo.mtimeMs) return true;

  const sourceRoot = path.join(root, "src");
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (visit(source)) return true;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const relative = path.relative(sourceRoot, source).replace(/\.ts$/u, ".js");
      const output = path.join(root, "dist", relative);
      const sourceInfo = fileStat(source);
      const outputInfo = fileStat(output);
      if (!sourceInfo || !outputInfo || sourceInfo.mtimeMs > outputInfo.mtimeMs) return true;
    }
    return false;
  };
  return visit(sourceRoot);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.signal) process.exit(1);
  process.exit(result.status ?? 1);
}

if (process.platform === "darwin") {
  if (needsMacUiBuild()) {
    const build = spawnSync("pnpm", ["run", "ui:build"], { cwd: root, stdio: "inherit", env: process.env });
    if (build.error) { console.error("无法运行 pnpm run ui:build：" + build.error.message); process.exit(1); }
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  run(process.execPath, [path.join(root, "dist/cli.js"), "setup", "--config", configPath]);
}

const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
run(process.execPath, [tsx, path.join(root, "src/cli.ts"), "setup", "--config", configPath]);