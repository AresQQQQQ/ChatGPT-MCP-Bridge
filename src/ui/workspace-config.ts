import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DEFAULT_ALLOWED_SCRIPTS = ["test", "build", "lint", "typecheck"] as const;
const WORKSPACE_MODES = ["readonly", "workspace", "trusted-dev", "handoff"] as const;
export type EditableWorkspaceMode = typeof WORKSPACE_MODES[number];

interface RawWorkspace {
  readonly id?: unknown;
  readonly root?: unknown;
  readonly mode?: unknown;
  readonly allowedScripts?: unknown;
  readonly [key: string]: unknown;
}

interface RawConfig {
  readonly codex?: unknown;
  readonly workspaces?: unknown;
  readonly [key: string]: unknown;
}

export interface EditableWorkspace {
  readonly originalId?: string;
  readonly id: string;
  readonly root: string;
  readonly mode: EditableWorkspaceMode;
}

export interface WorkspaceConfigSnapshot {
  readonly workspaces: readonly EditableWorkspace[];
  readonly key: string;
}

function parseRawConfig(content: string, configPath: string): RawConfig {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`配置文件 JSON 无效：${configPath}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`配置文件格式无效：${configPath}`);
  }
  return value as RawConfig;
}

function rawWorkspaces(config: RawConfig, configPath: string): RawWorkspace[] {
  if (!Array.isArray(config.workspaces) || config.workspaces.length === 0) {
    throw new Error(`配置文件至少需要一个 workspace：${configPath}`);
  }
  return config.workspaces.map((workspace) => {
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
      throw new Error(`配置文件 workspace 格式无效：${configPath}`);
    }
    return workspace as RawWorkspace;
  });
}

function normalizeRoot(root: string, configPath: string): string {
  return path.resolve(path.dirname(configPath), root.trim());
}

function normalizeMode(mode: unknown): EditableWorkspaceMode {
  return typeof mode === "string" && (WORKSPACE_MODES as readonly string[]).includes(mode)
    ? mode as EditableWorkspaceMode
    : "workspace";
}

function validateWorkspaceInput(workspaces: readonly EditableWorkspace[], configPath: string): EditableWorkspace[] {
  if (workspaces.length === 0) throw new Error("至少保留一个项目配置");
  const ids = new Set<string>();
  return workspaces.map((workspace, index) => {
    const id = workspace.id.trim();
    const root = workspace.root.trim();
    const mode = workspace.mode;
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      throw new Error(`第 ${index + 1} 个项目 ID 无效，只能使用字母、数字、点、下划线或短横线`);
    }
    if (ids.has(id)) throw new Error(`项目 ID 重复：${id}`);
    ids.add(id);
    if (!root) throw new Error(`项目 ${id} 的文件夹路径不能为空`);
    if (root.includes("\0")) throw new Error(`项目 ${id} 的文件夹路径无效`);
    if (!(WORKSPACE_MODES as readonly string[]).includes(mode)) throw new Error(`项目 ${id} 的权限模式无效：${mode}`);
    return {
      ...(workspace.originalId ? { originalId: workspace.originalId } : {}),
      id,
      root: normalizeRoot(root, configPath),
      mode,
    };
  });
}

async function ensureWorkspaceRoots(workspaces: readonly EditableWorkspace[]): Promise<void> {
  for (const workspace of workspaces) {
    let metadata;
    try {
      metadata = await stat(workspace.root);
    } catch {
      throw new Error(`项目文件夹不存在：${workspace.root}`);
    }
    if (!metadata.isDirectory()) throw new Error(`项目路径不是文件夹：${workspace.root}`);
  }
}

export async function readWorkspaceConfig(configPath: string): Promise<WorkspaceConfigSnapshot> {
  const content = await readFile(configPath, "utf8");
  const config = parseRawConfig(content, configPath);
  const workspaces = rawWorkspaces(config, configPath).map((workspace) => {
    if (typeof workspace.id !== "string" || typeof workspace.root !== "string") {
      throw new Error(`配置文件 workspace 缺少有效的 id/root：${configPath}`);
    }
    return {
      originalId: workspace.id,
      id: workspace.id,
      root: normalizeRoot(workspace.root, configPath),
      mode: normalizeMode(workspace.mode),
    };
  });
  return { workspaces, key: content };
}

export async function writeWorkspaceConfig(configPath: string, requested: readonly EditableWorkspace[]): Promise<void> {
  const validated = validateWorkspaceInput(requested, configPath);
  await ensureWorkspaceRoots(validated);

  const content = await readFile(configPath, "utf8");
  const config = parseRawConfig(content, configPath);
  const existing = rawWorkspaces(config, configPath);
  const byId = new Map<string, RawWorkspace>();
  for (const workspace of existing) {
    if (typeof workspace.id === "string") byId.set(workspace.id, workspace);
  }

  const nextWorkspaces = validated.map((workspace) => {
    const previous = workspace.originalId ? byId.get(workspace.originalId) : undefined;
    if (previous) {
      return { ...previous, id: workspace.id, root: workspace.root, mode: workspace.mode };
    }
    return {
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      allowedScripts: [...DEFAULT_ALLOWED_SCRIPTS],
      ...(config.codex !== undefined || existing.some((candidate) => candidate.codex !== undefined)
        ? { codex: { enabled: true } }
        : {}),
    };
  });

  const nextConfig = { ...config, workspaces: nextWorkspaces };
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
