import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_ALLOWED_PACKAGE_SCRIPTS,
  RuntimeNotFoundError,
  type PackageManagerConfig,
  type PackageManagerKind,
  type ResolvedRuntime,
  type RuntimeName,
  type RuntimeProbe,
} from "./types.js";
import { CommandPolicyError } from "./types.js";

const execFileAsync = promisify(execFile);
const RUNTIME_PROBE_TIMEOUT_MS = 2_000;
const PACKAGE_MANAGER_KINDS = ["npm", "pnpm", "yarn", "bun"] as const;

const SAFE_ENV_KEYS_POSIX = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM"] as const;
const SAFE_ENV_KEYS_WINDOWS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "LANG",
  "LC_ALL",
] as const;

interface PackageManifest {
  readonly packageManager?: unknown;
  readonly scripts?: unknown;
}

export interface RuntimeWorkspaceSpec {
  readonly id?: string;
  readonly root: string;
  readonly mode?: string;
  readonly allowedScripts?: readonly string[];
}

export function createSanitizedChildEnv(
  nodeExecutable = process.execPath,
  trustedRuntimeDirectories: readonly string[] = [],
): NodeJS.ProcessEnv {
  const source = process.env;
  const env: NodeJS.ProcessEnv = {};
  const keys = process.platform === "win32" ? SAFE_ENV_KEYS_WINDOWS : SAFE_ENV_KEYS_POSIX;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  const nodeDirectory = path.dirname(nodeExecutable);
  const inheritedPath = process.platform === "win32"
    ? (source.Path ?? source.PATH)
    : (source.PATH ?? source.Path);
  const runtimeDirectories = trustedRuntimeDirectories
    .filter((value) => path.isAbsolute(value))
    .map((value) => path.normalize(value));
  const pathValue = [...new Set([nodeDirectory, ...runtimeDirectories, inheritedPath]
    .filter((value): value is string => typeof value === "string" && value.length > 0))]
    .join(path.delimiter);
  if (process.platform === "win32") {
    env.Path = pathValue;
  } else {
    env.PATH = pathValue;
  }

  // These are explicit, non-user-controlled values needed by inspection commands.
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function regularFileExists(filePath: string, requireExecutable: boolean): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) return false;
    if (requireExecutable && process.platform !== "win32") await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathEntries(): readonly string[] {
  const raw = process.platform === "win32"
    ? (process.env.Path ?? process.env.PATH ?? "")
    : (process.env.PATH ?? process.env.Path ?? "");
  const seen = new Set<string>();
  const result: string[] = [];
  // bridge-ui.cmd may start an absolute fallback Node executable whose
  // directory is not present in the inherited PATH. Search that trusted
  // runtime directory as well so adjacent package-manager shims remain usable.
  for (const item of [path.dirname(process.execPath), ...raw.split(path.delimiter)]) {
    if (!item || !path.isAbsolute(item)) continue;
    const normalized = path.normalize(item);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

async function usablePath(candidate: string, workspaceRoot?: string): Promise<string | undefined> {
  const absolute = path.resolve(candidate);
  if (workspaceRoot && isContained(workspaceRoot, absolute)) return undefined;
  if (!await regularFileExists(absolute, true)) return undefined;
  if (workspaceRoot) {
    const canonical = await realpath(absolute).catch(() => undefined);
    if (!canonical || isContained(workspaceRoot, canonical)) return undefined;
  }
  return absolute;
}

function managerScriptNames(kind: PackageManagerKind): readonly string[] {
  switch (kind) {
    case "npm": return ["npm-cli.js"];
    case "pnpm": return ["pnpm.mjs", "pnpm.cjs", "pnpm.js"];
    case "yarn": return ["yarn.js", "yarn.cjs", "yarn.mjs"];
    case "bun": return ["bun.js", "bun.cjs", "bun.mjs"];
  }
}

function isKnownManagerScript(kind: PackageManagerKind, candidate: string): boolean {
  const baseName = path.basename(candidate).toLowerCase();
  return managerScriptNames(kind).some((name) => name.toLowerCase() === baseName);
}

function expandCmdToken(token: string, directory: string): string | undefined {
  const cleaned = token.replace(/[;,]+$/u, "");
  if (/^%~dp0/iu.test(cleaned)) {
    const suffix = cleaned.replace(/^%~dp0/iu, "").replace(/^[/\\]+/u, "");
    if (!suffix || /[%\r\n\0]/u.test(suffix)) return undefined;
    return path.resolve(directory, suffix);
  }
  if (path.isAbsolute(cleaned) && !/[%\r\n\0]/u.test(cleaned)) return cleaned;
  return undefined;
}

async function resolveCmdWrapper(
  kind: PackageManagerKind,
  wrapperPath: string,
  nodeExecutable: string,
  workspaceRoot?: string,
): Promise<ResolvedRuntime | undefined> {
  const directory = path.dirname(wrapperPath);
  const scriptCandidates = managerScriptNames(kind).flatMap((name) => [
    path.join(directory, "node_modules", kind, "bin", name),
    path.resolve(directory, "..", kind, "bin", name),
    path.resolve(directory, "..", "..", "node", "node_modules", kind, "bin", name),
    path.join(path.dirname(nodeExecutable), "node_modules", kind, "bin", name),
  ]);

  for (const candidate of scriptCandidates) {
    if (await usablePath(candidate, workspaceRoot)) {
      return { kind, executable: nodeExecutable, args: [candidate], nodeExecutable, source: wrapperPath };
    }
  }

  const source = await readFile(wrapperPath, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  const tokenPattern = /"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+)/gu;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token) continue;
    const expanded = expandCmdToken(token, directory);
    if (!expanded || !isKnownManagerScript(kind, expanded)) continue;
    const script = await usablePath(expanded, workspaceRoot);
    if (script) return { kind, executable: nodeExecutable, args: [script], nodeExecutable, source: wrapperPath };
  }
  return undefined;
}

async function runtimeFromCandidate(
  kind: RuntimeName,
  candidate: string,
  nodeExecutable: string,
  workspaceRoot?: string,
): Promise<ResolvedRuntime | undefined> {
  if (kind !== "node" && kind !== "git" && process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd")) {
    return resolveCmdWrapper(kind as PackageManagerKind, candidate, nodeExecutable, workspaceRoot);
  }
  if (kind === "git" && process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd")) return undefined;
  const executable = await usablePath(candidate, workspaceRoot);
  if (!executable) return undefined;
  if (kind !== "node" && /\.(?:cjs|mjs|js)$/iu.test(executable)) {
    return { kind, executable: nodeExecutable, args: [executable], nodeExecutable, source: candidate };
  }
  return { kind, executable, args: [], nodeExecutable, source: candidate };
}

async function resolveNodeExecutable(candidate = process.execPath): Promise<string> {
  if (!path.isAbsolute(candidate) || !await regularFileExists(candidate, false)) {
    throw new RuntimeNotFoundError("node", `Required runtime 'node' was not found at '${candidate}'`);
  }
  return candidate;
}

export async function resolveRuntime(kind: RuntimeName, workspaceRoot?: string): Promise<ResolvedRuntime> {
  const nodeExecutable = await resolveNodeExecutable();
  if (kind === "node") {
    return { kind, executable: nodeExecutable, args: [], nodeExecutable, source: "process.execPath" };
  }

  const directories = pathEntries();
  const names = process.platform === "win32"
    ? kind === "git"
      ? ["git.exe"]
      : [`${kind}.exe`, `${kind}.cmd`, `${kind}.cjs`, `${kind}.mjs`, `${kind}.js`]
    : [kind];
  for (const directory of directories) {
    for (const name of names) {
      const runtime = await runtimeFromCandidate(kind, path.join(directory, name), nodeExecutable, workspaceRoot);
      if (runtime) return runtime;
    }
  }

  throw new RuntimeNotFoundError(kind);
}

async function verifyRuntime(runtime: ResolvedRuntime): Promise<void> {
  try {
    await execFileAsync(runtime.executable, [...runtime.args, "--version"], {
      shell: false,
      windowsHide: true,
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: createSanitizedChildEnv(runtime.nodeExecutable),
    });
  } catch (error) {
    throw new RuntimeNotFoundError(runtime.kind, `Required runtime '${runtime.kind}' could not be started`);
  }
}

export async function requireRuntime(kind: RuntimeName, workspaceRoot?: string): Promise<ResolvedRuntime> {
  const runtime = await resolveRuntime(kind, workspaceRoot);
  await verifyRuntime(runtime);
  return runtime;
}

export async function probeRuntime(kind: RuntimeName): Promise<RuntimeProbe> {
  try {
    const runtime = await requireRuntime(kind);
    return { kind, status: "FOUND", runtime };
  } catch (error) {
    return {
      kind,
      status: "NOT FOUND",
      detail: error instanceof Error ? error.message : `Required runtime '${kind}' was not found`,
    };
  }
}

async function readPackageManifest(cwd: string): Promise<PackageManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CommandPolicyError("package.json is invalid");
    }
    return value as PackageManifest;
  } catch (error) {
    if (error instanceof CommandPolicyError) throw error;
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CommandPolicyError("package.json is missing or invalid");
  }
}

function packageManagerFromManifest(value: unknown): PackageManagerKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CommandPolicyError("package.json packageManager is invalid");
  const match = /^(npm|pnpm|yarn|bun)@[^\s]+$/u.exec(value.trim());
  if (!match) throw new CommandPolicyError("package.json packageManager is invalid");
  return match[1] as PackageManagerKind;
}

export async function discoverPackageManager(cwd: string): Promise<PackageManagerKind> {
  const manifest = await readPackageManifest(cwd);
  const declared = packageManagerFromManifest(manifest?.packageManager);
  if (declared) return declared;
  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(cwd, "package-lock.json")) || await fileExists(path.join(cwd, "npm-shrinkwrap.json"))) return "npm";
  if (await fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(cwd, "bun.lockb")) || await fileExists(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

export async function resolvePackageManager(
  config: PackageManagerConfig,
  workspaceRoot: string,
): Promise<ResolvedRuntime> {
  const nodeExecutable = await resolveNodeExecutable(config.nodeExecutable ?? process.execPath);
  if (config.executable !== undefined) {
    if (!path.isAbsolute(config.executable)) {
      throw new CommandPolicyError("configured package manager executable must be absolute");
    }
    const runtime = await runtimeFromCandidate(config.kind, config.executable, nodeExecutable);
    if (!runtime) throw new RuntimeNotFoundError(config.kind, `Required runtime '${config.kind}' was not found at '${config.executable}'`);
    return runtime;
  }
  return resolveRuntime(config.kind, workspaceRoot);
}

export async function requirePackageManager(
  config: PackageManagerConfig,
  workspaceRoot: string,
): Promise<ResolvedRuntime> {
  const runtime = await resolvePackageManager(config, workspaceRoot);
  await verifyRuntime(runtime);
  return runtime;
}

export async function discoverRequiredPackageManagers(
  workspaces: readonly RuntimeWorkspaceSpec[],
): Promise<ReadonlyMap<PackageManagerKind, readonly string[]>> {
  const required = new Map<PackageManagerKind, string[]>();
  for (const workspace of workspaces) {
    const mode = workspace.mode ?? "workspace";
    if (mode !== "workspace" && mode !== "trusted-dev") continue;
    const allowed = workspace.allowedScripts ?? DEFAULT_ALLOWED_PACKAGE_SCRIPTS;
    if (allowed.length === 0) continue;
    try {
      const manifest = await readPackageManifest(workspace.root);
      if (!manifest || typeof manifest.scripts !== "object" || manifest.scripts === null || Array.isArray(manifest.scripts)) continue;
      const scripts = manifest.scripts as Record<string, unknown>;
      if (!Object.keys(scripts).some((name) => allowed.includes(name))) continue;
      const kind = await discoverPackageManager(workspace.root);
      const ids = required.get(kind) ?? [];
      ids.push(workspace.id ?? workspace.root);
      required.set(kind, ids);
    } catch {
      // The workspace check reports invalid/unavailable roots separately.
    }
  }
  return required;
}

export { PACKAGE_MANAGER_KINDS };
