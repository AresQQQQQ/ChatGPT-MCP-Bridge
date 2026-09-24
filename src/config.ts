import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

const safeLocalIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "must use letters, numbers, dots, underscores, or hyphens",
);

const codexWorkspaceSchema = z.object({
  enabled: z.boolean().default(true),
  modules: z.record(
    safeLocalIdSchema,
    z.string().min(1).max(128),
  ).optional(),
});

const workspaceMcpServerSchema = z.object({
  url: z.string().url().refine(isLoopbackUrl, "must use a loopback http URL"),
}).strict();

function isSafeRecipeExecutable(value: string): boolean {
  if (!value || /[\u0000\r\n]/u.test(value)) return false;
  if (path.isAbsolute(value)) return true;
  return !/[\\/]/u.test(value) && /^[A-Za-z0-9._+-]+$/u.test(value);
}

function isSafeRecipeCwd(value: string): boolean {
  if (!value || /[\u0000\r\n]/u.test(value)) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return false;
  if (value === ".") return true;
  if (/[\\/]{2}/u.test(value)) return false;
  const segments = value.split(/[\\/]/u);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const workspaceRecipeSchema = z.object({
  description: z.string().trim().min(1).max(256).optional(),
  executable: z.string().min(1).max(4096).refine(isSafeRecipeExecutable, "must be an absolute executable path or safe executable name"),
  args: z.array(z.string().max(4096).refine((value) => !/[\u0000\r\n]/u.test(value), "must not contain control characters")).max(128).default([]),
  cwd: z.string().min(1).max(4096).refine(isSafeRecipeCwd, "must be a safe workspace-relative directory").optional(),
  timeoutMs: z.number().int().min(1).max(10 * 60 * 1_000).optional(),
}).strict().superRefine((recipe, context) => {
  const totalArgChars = recipe.args.reduce((sum, value) => sum + value.length, 0);
  if (totalArgChars > 64 * 1024) {
    context.addIssue({ code: "custom", path: ["args"], message: "total argument length exceeds 64 KiB" });
  }
});

const workspaceConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must use letters, numbers, dots, underscores, or hyphens"),
  root: z.string().min(1),
  mode: z.enum(["readonly", "workspace", "trusted-dev", "handoff"]).optional(),
  maxReadBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
  allowedScripts: z.array(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$/, "must be a safe package script name"),
  ).max(64).optional(),
  codex: codexWorkspaceSchema.optional(),
  mcpServers: z.record(safeLocalIdSchema, workspaceMcpServerSchema).optional(),
  recipes: z.record(safeLocalIdSchema, workspaceRecipeSchema).optional(),
});

const authTokenSchema = z.string().refine(isStrongAuthToken, "must be a base64url token containing at least 32 bytes");
const allowedHostSchema = z.string().min(1).refine(isValidAllowedHost, "must be an exact hostname or IP address");
const allowedOriginSchema = z.string().refine(isExactOrigin, "must be an exact http(s) origin");
const tunnelConfigSchema = z.object({
  clientPath: z.string().min(1),
  profileDir: z.string().min(1).optional(),
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a safe profile name"),
  healthUrl: z.string().url().refine(isLoopbackUrl, "must use a loopback http URL").optional(),
});

const codexConfigSchema = z.object({
  clientPath: z.string().min(1).optional(),
});

const fileConfigSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  mcpPath: z.string().regex(/^\/[^\s]*$/, "must be an absolute URL path").optional(),
  maxReadBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
  auth: z.object({ token: authTokenSchema }).optional(),
  allowedHosts: z.array(allowedHostSchema).min(1).optional(),
  allowedOrigins: z.array(allowedOriginSchema).min(1).optional(),
  tunnel: tunnelConfigSchema.optional(),
  codex: codexConfigSchema.optional(),
  workspaces: z.array(workspaceConfigSchema).min(1),
});

export interface CodexWorkspaceConfig {
  readonly enabled: boolean;
  readonly modules?: Readonly<Record<string, string>>;
}

export interface WorkspaceMcpServerConfig {
  readonly url: string;
}

export interface WorkspaceRecipeConfig {
  readonly description?: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface WorkspaceConfig {
  readonly id: string;
  readonly root: string;
  readonly mode?: WorkspaceMode;
  readonly maxReadBytes?: number;
  readonly allowedScripts?: readonly string[];
  readonly codex?: CodexWorkspaceConfig;
  readonly mcpServers?: Readonly<Record<string, WorkspaceMcpServerConfig>>;
  readonly recipes?: Readonly<Record<string, WorkspaceRecipeConfig>>;
}

export type WorkspaceMode = "readonly" | "workspace" | "trusted-dev" | "handoff";

export function isWorkspaceWritableMode(mode: WorkspaceMode): boolean {
  return mode === "workspace" || mode === "trusted-dev";
}

export function isTrustedDevMode(mode: WorkspaceMode): boolean {
  return mode === "trusted-dev";
}

export interface AuthConfig {
  readonly token: string;
}

export interface CodexConfig {
  readonly clientPath?: string;
  readonly stateFile: string;
}

export interface BridgeConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly maxReadBytes: number;
  readonly auth?: AuthConfig;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly tunnel?: TunnelConfig;
  readonly codex?: CodexConfig;
  readonly workspaces: readonly WorkspaceConfig[];
  readonly configPath: string;
}

export interface TunnelConfig {
  readonly clientPath: string;
  readonly profileDir?: string;
  readonly profile: string;
  readonly healthUrl: string;
}

export const DEFAULT_CONFIG_FILE = "mcp-bridge.json";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_MCP_PATH = "/mcp";
export const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
export const AUTH_TOKEN_BYTES = 32;
export const DEFAULT_TUNNEL_HEALTH_URL = "http://127.0.0.1:8080";

export function createAuthToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString("base64url");
}

export function isStrongAuthToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").byteLength >= AUTH_TOKEN_BYTES;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function isValidAllowedHost(value: string): boolean {
  const normalized = value.trim();
  if (normalized !== value || normalized.includes("/") || normalized.includes("*") || normalized.includes("://")) {
    return false;
  }
  const unwrapped = normalized.replace(/^\[|\]$/g, "");
  return isIP(unwrapped) === 6 || /^[A-Za-z0-9.-]+$/.test(unwrapped);
}

export function isExactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
  } catch {
    return false;
  }
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function defaultConfig(configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILE)): BridgeConfig {
  const absoluteConfigPath = path.resolve(configPath);
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    mcpPath: DEFAULT_MCP_PATH,
    maxReadBytes: DEFAULT_MAX_READ_BYTES,
    auth: { token: createAuthToken() },
    workspaces: [{ id: "default", root: path.dirname(absoluteConfigPath) }],
    configPath: absoluteConfigPath,
  };
}

export function configFileTemplate(authToken = createAuthToken()): string {
  return `${JSON.stringify(
    {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      mcpPath: DEFAULT_MCP_PATH,
      maxReadBytes: DEFAULT_MAX_READ_BYTES,
      auth: { token: authToken },
      workspaces: [{
        id: "default",
        root: ".",
        mode: "workspace",
        allowedScripts: ["test", "build", "lint", "typecheck"],
      }],
    },
    null,
    2,
  )}\n`;
}

export async function loadConfig(
  configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILE),
): Promise<BridgeConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config: ${absoluteConfigPath}`);
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Config file not found: ${absoluteConfigPath}`);
    }
    throw error;
  }

  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid config ${absoluteConfigPath}: ${issue?.path.join(".") || "root"} ${issue?.message ?? "invalid value"}`);
  }

  const ids = new Set<string>();
  const configDirectory = path.dirname(absoluteConfigPath);
  const workspaces = parsed.data.workspaces.map((workspace) => {
    if (ids.has(workspace.id)) {
      throw new Error(`Invalid config ${absoluteConfigPath}: duplicate workspace id '${workspace.id}'`);
    }
    ids.add(workspace.id);
    return {
      id: workspace.id,
      root: path.resolve(configDirectory, workspace.root),
      ...(workspace.mode ? { mode: workspace.mode } : {}),
      ...(workspace.maxReadBytes !== undefined ? { maxReadBytes: workspace.maxReadBytes } : {}),
      ...(workspace.allowedScripts ? { allowedScripts: [...new Set(workspace.allowedScripts)] } : {}),
      ...(workspace.codex ? {
        codex: {
          enabled: workspace.codex.enabled,
          ...(workspace.codex.modules ? { modules: { ...workspace.codex.modules } } : {}),
        },
      } : {}),
      ...(workspace.mcpServers ? {
        mcpServers: Object.fromEntries(
          Object.entries(workspace.mcpServers).map(([serverId, server]) => [serverId, { url: server.url }]),
        ),
      } : {}),
      ...(workspace.recipes ? {
        recipes: Object.fromEntries(
          Object.entries(workspace.recipes).map(([recipeId, recipe]) => [recipeId, {
            ...(recipe.description ? { description: recipe.description } : {}),
            executable: recipe.executable,
            args: [...recipe.args],
            ...(recipe.cwd ? { cwd: recipe.cwd } : {}),
            ...(recipe.timeoutMs !== undefined ? { timeoutMs: recipe.timeoutMs } : {}),
          }]),
        ),
      } : {}),
    };
  });

  return {
    host: parsed.data.host ?? DEFAULT_HOST,
    port: parsed.data.port ?? DEFAULT_PORT,
    mcpPath: parsed.data.mcpPath ?? DEFAULT_MCP_PATH,
    maxReadBytes: parsed.data.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    ...(parsed.data.auth ? { auth: parsed.data.auth } : {}),
    ...(parsed.data.allowedHosts ? { allowedHosts: parsed.data.allowedHosts } : {}),
    ...(parsed.data.allowedOrigins ? { allowedOrigins: parsed.data.allowedOrigins } : {}),
    ...(parsed.data.tunnel
      ? {
          tunnel: {
            clientPath: path.resolve(configDirectory, parsed.data.tunnel.clientPath),
            ...(parsed.data.tunnel.profileDir ? { profileDir: path.resolve(configDirectory, parsed.data.tunnel.profileDir) } : {}),
            profile: parsed.data.tunnel.profile,
            healthUrl: parsed.data.tunnel.healthUrl ?? DEFAULT_TUNNEL_HEALTH_URL,
          },
        }
      : {}),
    ...(parsed.data.codex ? {
      codex: {
        ...(parsed.data.codex.clientPath ? { clientPath: path.resolve(configDirectory, parsed.data.codex.clientPath) } : {}),
        stateFile: path.resolve(configDirectory, ".mcp-bridge-state", "codex.json"),
      },
    } : {}),
    workspaces,
    configPath: absoluteConfigPath,
  };
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
