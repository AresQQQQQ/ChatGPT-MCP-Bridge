import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isWorkspaceWritableMode, type WorkspaceMode } from "../config.js";

export type SandboxPlatform = "win32" | "posix";
export type SymlinkPolicy = "deny" | "allow-if-contained";
export type PathOperation = "read" | "list" | "stat" | "create" | "write";

export type PathSecurityCode =
  | "PATH_OUTSIDE_WORKSPACE"
  | "INVALID_PATH"
  | "ABSOLUTE_PATH"
  | "DRIVE_RELATIVE_PATH"
  | "DEVICE_PATH"
  | "PATH_TRAVERSAL"
  | "SENSITIVE_PATH"
  | "MISSING_TARGET"
  | "MISSING_PARENT"
  | "PARENT_NOT_DIRECTORY"
  | "SYMLINK_DISALLOWED"
  | "SYMLINK_ESCAPE"
  | "PATH_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "ROOT_INVALID";

const PATH_SECURITY_MESSAGES: Record<PathSecurityCode, string> = {
  PATH_OUTSIDE_WORKSPACE: "Path is outside the configured workspace",
  INVALID_PATH: "Invalid workspace-relative path",
  ABSOLUTE_PATH: "Absolute paths are not allowed",
  DRIVE_RELATIVE_PATH: "Windows drive-relative paths are not allowed",
  DEVICE_PATH: "Windows device and UNC paths are not allowed",
  PATH_TRAVERSAL: "Parent traversal and repeated separators are not allowed",
  SENSITIVE_PATH: "The requested path is blocked by the workspace security policy",
  MISSING_TARGET: "The requested path does not exist",
  MISSING_PARENT: "The target parent directory does not exist",
  PARENT_NOT_DIRECTORY: "The target parent is not a directory",
  SYMLINK_DISALLOWED: "Symbolic links are not allowed by the workspace security policy",
  SYMLINK_ESCAPE: "The requested path resolves outside the configured workspace",
  PATH_UNAVAILABLE: "The requested path is unavailable",
  PERMISSION_DENIED: "The workspace mode does not permit this operation",
  ROOT_INVALID: "The configured workspace is unavailable",
};

const PATH_SECURITY_CODES = new Set<string>(Object.keys(PATH_SECURITY_MESSAGES));

export class PathSecurityError extends Error {
  public readonly code: PathSecurityCode;

  public constructor(codeOrMessage: PathSecurityCode | string = "PATH_OUTSIDE_WORKSPACE", message?: string) {
    const isCode = PATH_SECURITY_CODES.has(codeOrMessage);
    const code = isCode ? codeOrMessage as PathSecurityCode : "PATH_OUTSIDE_WORKSPACE";
    super(message ?? PATH_SECURITY_MESSAGES[code]);
    this.name = "PathSecurityError";
    this.code = code;
  }
}

export interface SandboxRootSpec {
  readonly id: string;
  readonly path: string;
  readonly mode?: WorkspaceMode;
}

export interface PathSandboxOptions {
  readonly symlinkPolicy?: SymlinkPolicy;
  readonly platform?: SandboxPlatform;
}

export interface ResolvePathRequest {
  readonly rootId: string;
  readonly relativePath: string;
  readonly operation: PathOperation;
}

export interface ResolvedPath {
  readonly rootId: string;
  readonly rootPath: string;
  /** The path used for the final filesystem operation. Never expose this to callers. */
  readonly lexicalPath: string;
  readonly canonicalPath?: string;
  readonly canonicalParentPath: string;
  readonly exists: boolean;
  readonly kind?: "file" | "directory" | "symlink" | "other";
}

interface RegisteredRoot {
  readonly id: string;
  readonly rootPath: string;
  readonly mode: WorkspaceMode;
}

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".hg",
  ".svn",
  ".bzr",
  "node_modules",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  "cache",
  ".cache",
  "tmp",
  "temp",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".npm",
  ".mcp-bridge-state",
]);

const BLOCKED_FILE_NAMES = new Set([
  ".git",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "authorized_keys",
  "known_hosts",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_xmss",
  "private_key",
  "credentials",
  "credentials.json",
  "service-account.json",
]);

const POSIX_SENSITIVE_PREFIXES = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/var/run"];
const WINDOWS_SENSITIVE_PREFIXES = [
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\$recycle.bin",
  "\\system volume information",
];

function getPathApi(platform: SandboxPlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function getPlatform(platform?: SandboxPlatform): SandboxPlatform {
  return platform ?? (process.platform === "win32" ? "win32" : "posix");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isContainedInternal(root: string, candidate: string, platform: SandboxPlatform): boolean {
  const p = getPathApi(platform);
  const fold = platform === "win32"
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  const relative = p.relative(fold(root), fold(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${p.sep}`) &&
    !p.isAbsolute(relative)
  );
}

export function isPathContained(
  root: string,
  candidate: string,
  platform: SandboxPlatform = getPlatform(),
): boolean {
  return isContainedInternal(root, candidate, platform);
}

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
}

function isBlockedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_FILE_NAMES.has(lower) ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key");
}

export function isBlockedWorkspacePath(relativePath: string): boolean {
  const segments = pathSegments(relativePath);
  return segments.some((segment) => BLOCKED_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    (segments.length > 0 && isBlockedFileName(segments[segments.length - 1] ?? ""));
}

function isSensitiveAbsolutePath(candidate: string, platform: SandboxPlatform): boolean {
  const p = getPathApi(platform);
  const normalized = p.normalize(candidate);
  if (platform === "posix") {
    return POSIX_SENSITIVE_PREFIXES.some((prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
  }

  const lower = normalized.toLowerCase();
  const withoutDrive = lower.replace(/^[a-z]:/u, "");
  const normalizedTemp = p.normalize(tmpdir()).toLowerCase();
  if (lower === normalizedTemp || lower.startsWith(`${normalizedTemp}\\`)) {
    return false;
  }
  if (WINDOWS_SENSITIVE_PREFIXES.some((prefix) =>
    withoutDrive === prefix || withoutDrive.startsWith(`${prefix}\\`),
  )) {
    return true;
  }

  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const normalizedProfile = p.normalize(userProfile).toLowerCase();
    if (lower === normalizedProfile || lower.startsWith(`${normalizedProfile}\\`)) {
      const relativeToProfile = p.relative(normalizedProfile, lower);
      return pathSegments(relativeToProfile).some((segment) =>
        [".ssh", ".aws", ".azure", ".kube", "appdata"].includes(segment.toLowerCase()),
      );
    }
  }
  return false;
}

function isBlockedRootPath(candidate: string, platform: SandboxPlatform): boolean {
  const p = getPathApi(platform);
  const normalized = p.normalize(candidate);
  const normalizedTemp = p.normalize(tmpdir());
  if (isContainedInternal(normalizedTemp, normalized, platform)) {
    return isBlockedWorkspacePath(p.relative(normalizedTemp, normalized));
  }
  return isBlockedWorkspacePath(normalized);
}

function assertRelativeInput(relativePath: string, platform: SandboxPlatform): void {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 4096) {
    throw new PathSecurityError("INVALID_PATH");
  }
  if (relativePath.includes("\0") || /[\u0001-\u001f\u007f]/u.test(relativePath)) {
    throw new PathSecurityError("INVALID_PATH");
  }

  const p = getPathApi(platform);
  if (p.isAbsolute(relativePath) || /^[\\/]/u.test(relativePath)) {
    throw new PathSecurityError("ABSOLUTE_PATH");
  }
  if (platform === "win32") {
    if (/^[a-z]:/iu.test(relativePath)) {
      throw new PathSecurityError("DRIVE_RELATIVE_PATH");
    }
    if (/^\\\\/u.test(relativePath) || /^\\\\[.?]\\/u.test(relativePath)) {
      throw new PathSecurityError("DEVICE_PATH");
    }
  }
  if (/[\\/]{2}/u.test(relativePath)) {
    throw new PathSecurityError("PATH_TRAVERSAL");
  }

  const segments = relativePath.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) {
    throw new PathSecurityError("PATH_TRAVERSAL");
  }
  if (platform === "win32") {
    const reservedNames = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);
    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment.includes(":") || /[. ]$/u.test(segment)) {
        throw new PathSecurityError("INVALID_PATH");
      }
      const stem = segment.split(".", 1)[0]?.toUpperCase();
      if (stem && reservedNames.has(stem)) {
        throw new PathSecurityError("DEVICE_PATH");
      }
    }
  }
}

export function validateWorkspaceRelativePath(
  relativePath: string,
  platform: SandboxPlatform = getPlatform(),
): void {
  assertRelativeInput(relativePath, platform);
  if (isBlockedWorkspacePath(relativePath)) throw new PathSecurityError("SENSITIVE_PATH");
}

function kindFromStats(stats: Awaited<ReturnType<typeof lstat>>): NonNullable<ResolvedPath["kind"]> {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

export class PathSandbox {
  private readonly roots = new Map<string, RegisteredRoot>();
  private readonly symlinkPolicy: SymlinkPolicy;
  private readonly platform: SandboxPlatform;

  private constructor(options: Required<PathSandboxOptions>) {
    this.symlinkPolicy = options.symlinkPolicy;
    this.platform = options.platform;
  }

  public static async create(
    specs: readonly SandboxRootSpec[],
    options: PathSandboxOptions = {},
  ): Promise<PathSandbox> {
    const platform = getPlatform(options.platform);
    const sandbox = new PathSandbox({
      symlinkPolicy: options.symlinkPolicy ?? "deny",
      platform,
    });
    const p = getPathApi(platform);

    for (const spec of specs) {
      if (sandbox.roots.has(spec.id)) {
        throw new PathSecurityError("ROOT_INVALID");
      }
      try {
        const configuredRoot = p.resolve(spec.path);
        const rootStats = await lstat(configuredRoot);
        if (rootStats.isSymbolicLink() && sandbox.symlinkPolicy === "deny") {
          throw new PathSecurityError("SYMLINK_DISALLOWED");
        }
        const rootPath = await realpath(configuredRoot);
        const canonicalStats = await lstat(rootPath);
        if (
          !canonicalStats.isDirectory() ||
          isSensitiveAbsolutePath(rootPath, platform) ||
          isBlockedRootPath(rootPath, platform)
        ) {
          throw new PathSecurityError("ROOT_INVALID");
        }
        sandbox.roots.set(spec.id, {
          id: spec.id,
          rootPath,
          mode: spec.mode ?? "workspace",
        });
      } catch (error) {
        if (error instanceof PathSecurityError && error.code === "SYMLINK_DISALLOWED") {
          throw error;
        }
        throw new PathSecurityError("ROOT_INVALID");
      }
    }
    return sandbox;
  }

  public getRoot(rootId: string): { readonly path: string; readonly mode: WorkspaceMode } {
    const root = this.requireRoot(rootId);
    return { path: root.rootPath, mode: root.mode };
  }

  public async resolve(request: ResolvePathRequest): Promise<ResolvedPath> {
    const root = this.requireRoot(request.rootId);
    this.assertOperationAllowed(root, request.operation);
    validateWorkspaceRelativePath(request.relativePath, this.platform);

    const p = getPathApi(this.platform);
    const lexicalPath = p.resolve(root.rootPath, request.relativePath);
    if (!isContainedInternal(root.rootPath, lexicalPath, this.platform)) {
      throw new PathSecurityError("PATH_OUTSIDE_WORKSPACE");
    }

    const lexicalRelativePath = p.relative(root.rootPath, lexicalPath);
    if (isBlockedWorkspacePath(lexicalRelativePath)) {
      throw new PathSecurityError("SENSITIVE_PATH");
    }

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(lexicalPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (request.operation !== "create" && request.operation !== "write") {
          throw new PathSecurityError("MISSING_TARGET");
        }
        return this.resolveNewTarget(root, lexicalPath);
      }
      throw new PathSecurityError("PATH_UNAVAILABLE");
    }

    if (this.symlinkPolicy === "deny") {
      await this.assertNoSymlinkComponents(root.rootPath, lexicalPath);
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }
    if (!isContainedInternal(root.rootPath, canonicalPath, this.platform)) {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }

    const canonicalRelativePath = p.relative(root.rootPath, canonicalPath);
    if (isBlockedWorkspacePath(canonicalRelativePath) || isSensitiveAbsolutePath(canonicalPath, this.platform)) {
      throw new PathSecurityError("SENSITIVE_PATH");
    }

    const canonicalParentPath = lexicalPath === root.rootPath
      ? root.rootPath
      : await this.resolveContainedParent(root, p.dirname(lexicalPath));

    return {
      rootId: root.id,
      rootPath: root.rootPath,
      lexicalPath,
      canonicalPath,
      canonicalParentPath,
      exists: true,
      kind: kindFromStats(stats),
    };
  }

  private async resolveNewTarget(root: RegisteredRoot, lexicalPath: string): Promise<ResolvedPath> {
    const p = getPathApi(this.platform);
    const parentPath = p.dirname(lexicalPath);
    let parentStats: Awaited<ReturnType<typeof lstat>>;
    try {
      parentStats = await lstat(parentPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new PathSecurityError("MISSING_PARENT");
      }
      throw new PathSecurityError("PATH_UNAVAILABLE");
    }
    if (this.symlinkPolicy === "deny") {
      await this.assertNoSymlinkComponents(root.rootPath, parentPath);
    }
    let canonicalParentPath: string;
    try {
      canonicalParentPath = await realpath(parentPath);
    } catch {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }
    if (!parentStats.isDirectory()) {
      const canonicalParentStats = await lstat(canonicalParentPath).catch(() => undefined);
      if (!canonicalParentStats?.isDirectory()) {
        throw new PathSecurityError("PARENT_NOT_DIRECTORY");
      }
    }
    if (!isContainedInternal(root.rootPath, canonicalParentPath, this.platform)) {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }
    const canonicalRelativePath = p.relative(root.rootPath, canonicalParentPath);
    if (isBlockedWorkspacePath(canonicalRelativePath) || isSensitiveAbsolutePath(canonicalParentPath, this.platform)) {
      throw new PathSecurityError("SENSITIVE_PATH");
    }
    return {
      rootId: root.id,
      rootPath: root.rootPath,
      lexicalPath,
      canonicalParentPath,
      exists: false,
    };
  }

  private async resolveContainedParent(root: RegisteredRoot, parentPath: string): Promise<string> {
    if (this.symlinkPolicy === "deny") {
      await this.assertNoSymlinkComponents(root.rootPath, parentPath);
    }
    let canonicalParentPath: string;
    try {
      canonicalParentPath = await realpath(parentPath);
    } catch {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }
    if (!isContainedInternal(root.rootPath, canonicalParentPath, this.platform)) {
      throw new PathSecurityError("SYMLINK_ESCAPE");
    }
    return canonicalParentPath;
  }

  private async assertNoSymlinkComponents(rootPath: string, targetPath: string): Promise<void> {
    const p = getPathApi(this.platform);
    if (!isContainedInternal(rootPath, targetPath, this.platform)) {
      throw new PathSecurityError("PATH_OUTSIDE_WORKSPACE");
    }
    const relativePath = p.relative(rootPath, targetPath);
    if (!relativePath) return;
    let currentPath = rootPath;
    for (const segment of relativePath.split(p.sep)) {
      if (!segment) continue;
      currentPath = p.join(currentPath, segment);
      try {
        const stats = await lstat(currentPath);
        if (stats.isSymbolicLink()) {
          throw new PathSecurityError("SYMLINK_DISALLOWED");
        }
      } catch (error) {
        if (error instanceof PathSecurityError) throw error;
        if (isNodeError(error) && error.code === "ENOENT") return;
        throw new PathSecurityError("PATH_UNAVAILABLE");
      }
    }
  }

  private assertOperationAllowed(root: RegisteredRoot, operation: PathOperation): void {
    if ((operation === "create" || operation === "write") && !isWorkspaceWritableMode(root.mode)) {
      throw new PathSecurityError("PERMISSION_DENIED");
    }
  }

  private requireRoot(rootId: string): RegisteredRoot {
    const root = this.roots.get(rootId);
    if (!root) throw new PathSecurityError("ROOT_INVALID");
    return root;
  }
}

export async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  const sandbox = await PathSandbox.create([{ id: "root", path: root, mode: "workspace" }]);
  const resolved = await sandbox.resolve({ rootId: "root", relativePath, operation: "read" });
  if (!resolved.canonicalPath) throw new PathSecurityError("MISSING_TARGET");
  return resolved.canonicalPath;
}

export async function resolveWorkspaceRoot(root: string): Promise<string> {
  const sandbox = await PathSandbox.create([{ id: "root", path: root, mode: "workspace" }]);
  return sandbox.getRoot("root").path;
}
