import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify, parseEnv } from "node:util";
import { configFileTemplate, isLoopbackUrl, loadConfig } from "../config.js";

const exec = promisify(execFile);
const RELEASE_URL = "https://api.github.com/repos/openai/tunnel-client/releases/latest";
const MAX_ARCHIVE = 150 * 1024 * 1024;
interface Asset { name: string; size: number; digest: string; browser_download_url: string }
export interface Release { tag_name: string; assets: Asset[] }

export function selectAsset(release: Release, arch: string): Asset {
  const platformArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!platformArch) throw new Error("自动安装仅支持 Windows x64 / ARM64。");
  if (!/^v[0-9][A-Za-z0-9._-]*$/.test(release.tag_name)) throw new Error("官方版本信息无效。");
  const asset = release.assets.find(item => item.name === `tunnel-client-${release.tag_name}-windows-${platformArch}.zip`);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE) {
    throw new Error("官方发布缺少适用的 ZIP 或 SHA-256 校验值，已停止安装。");
  }
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/openai/tunnel-client/releases/download/") || url.username || url.password) {
    throw new Error("拒绝非官方客户端下载地址。");
  }
  return asset;
}

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`客户端下载请求失败（HTTP ${response.status}）。`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error("客户端下载超过大小限制。");
      chunks.push(Buffer.from(item.value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function verifyArchive(data: Buffer, asset: Asset): void {
  if (data.length !== asset.size || `sha256:${createHash("sha256").update(data).digest("hex")}` !== asset.digest) {
    throw new Error("客户端 SHA-256 或文件大小校验失败，未执行安装文件。");
  }
}

export async function installTunnelClient(directory: string, progress: (message: string) => void): Promise<string> {
  if (process.platform !== "win32") throw new Error("自动安装目前仅支持 Windows；其他系统请手动配置客户端。");
  progress("正在查询 openai/tunnel-client 官方版本…");
  const metadata = await readBounded(await fetch(RELEASE_URL, {
    headers: { "User-Agent": "ChatGPT-MCP-Bridge", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  }), 2 * 1024 * 1024);
  const release = JSON.parse(metadata.toString("utf8")) as Release;
  const asset = selectAsset(release, process.arch);
  progress(`正在下载 ${asset.name}…`);
  const bytes = await readBounded(await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) }), asset.size);
  verifyArchive(bytes, asset);
  const archive = path.join(directory, "client.zip");
  const executable = path.join(directory, "tunnel-client.exe");
  await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
  // Extract only the executable into an exact destination: no ZIP entry controls a filesystem path.
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:BRIDGE_SETUP_ARCHIVE)
try {
  $entries = @($zip.Entries | Where-Object { $_.Name -eq 'tunnel-client.exe' })
  if ($entries.Count -ne 1 -or $entries[0].Length -gt 209715200) { throw 'Invalid client archive' }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $env:BRIDGE_SETUP_EXECUTABLE, $false)
} finally { $zip.Dispose() }`;
  await runQuiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    BRIDGE_SETUP_ARCHIVE: archive, BRIDGE_SETUP_EXECUTABLE: executable,
  });
  await rm(archive);
  await writeFile(path.join(directory, "release.json"), JSON.stringify({ version: release.tag_name, asset: asset.name, digest: asset.digest }, null, 2));
  progress("客户端下载与 SHA-256 校验完成。");
  return executable;
}

async function runQuiet(executable: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const env = { ...process.env, ...extraEnv };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.MCP_EXTRA_HEADERS;
  delete env.MCP_DISCOVERY_EXTRA_HEADERS;
  try { await exec(executable, args, { windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024, env }); }
  catch { throw new Error("客户端解压或 profile 初始化失败；未切换 Bridge 配置。请检查客户端兼容性和目录权限。"); }
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function updateRuntimeKey(content: string, key: string): string {
  if (!key || /[\s\u0000-\u001f'"#]/u.test(key)) throw new Error("Runtime API key 不能为空或包含空白、引号等特殊字符。");
  // Re-serialize parsed assignments so duplicate/multiline values cannot shadow the new key.
  const values = parseEnv(content);
  values.CONTROL_PLANE_API_KEY = key;
  return Object.entries(values).map(([name, value]) => {
    if (value === undefined) return "";
    if (value.includes('"')) {
      if (value.includes("'")) throw new Error("现有 .env 包含无法安全保留的引号；请手动配置，原文件未修改。");
      return `${name}='${value}'`;
    }
    return `${name}="${value}"`;
  }).join("\n") + "\n";
}

export interface SetupInput { configPath: string; tunnelId: string; runtimeKey?: string; healthPort: number; reuseClient: boolean }
export interface SetupDependencies {
  install?: (directory: string, progress: (message: string) => void) => Promise<string>;
  initialize?: (client: string, args: string[]) => Promise<void>;
  progress?: (message: string) => void;
}

export async function setupTunnel(input: SetupInput, deps: SetupDependencies = {}): Promise<void> {
  if (!/^tunnel_[A-Za-z0-9_-]{1,128}$/.test(input.tunnelId)) throw new Error("请输入有效的 tunnel_ 开头的 Tunnel ID。");
  if (!Number.isInteger(input.healthPort) || input.healthPort < 1024 || input.healthPort > 65535) throw new Error("健康端口须为 1024–65535。");
  const configPath = path.resolve(input.configPath);
  const parent = path.dirname(configPath);
  const state = path.join(parent, ".mcp-bridge-state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lockPath = path.join(state, "setup.lock");
  try { await mkdir(lockPath); } catch { throw new Error("已有配置向导运行，或存在未清理的 .mcp-bridge-state/setup.lock。请先检查。"); }
  let stage: string | undefined;
  let switched = false;
  try {
    const original = await readOptional(configPath);
    const loaded = original === undefined ? undefined : await loadConfig(configPath);
    const raw = JSON.parse(original ?? configFileTemplate()) as Record<string, unknown>;
    const envPath = path.join(parent, ".env");
    const oldEnv = await readOptional(envPath);
    const key = input.runtimeKey || parseEnv(oldEnv ?? "").CONTROL_PLANE_API_KEY;
    const newEnv = updateRuntimeKey(oldEnv ?? "", key ?? "");
    if (input.healthPort === (loaded?.port ?? 3000)) throw new Error("健康端口不能与 Bridge 端口相同。");
    stage = await mkdtemp(path.join(state, "tunnel-setup-"));
    const progress = deps.progress ?? (() => undefined);
    let client: string;
    if (input.reuseClient && loaded?.tunnel) {
      client = loaded.tunnel.clientPath;
      await access(client);
      progress("复用已配置的客户端；创建独立 profile，保留原 profile。");
    } else client = await (deps.install ?? installTunnelClient)(stage, progress);
    const profileDir = path.join(stage, "profiles");
    const profile = "bridge";
    const host = loaded?.host ?? "127.0.0.1";
    const localHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
    const mcpUrl = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${loaded?.port ?? 3000}${loaded?.mcpPath ?? "/mcp"}`;
    if (!isLoopbackUrl(mcpUrl)) throw new Error("配置向导仅支持回环 Bridge 地址；当前主机地址请手动配置。");
    await (deps.initialize ?? runQuiet)(client, ["init", "--profile", profile, "--profile-dir", profileDir,
      "--tunnel-id", input.tunnelId, "--mcp-server-url", mcpUrl, "--health-listen-addr", `127.0.0.1:${input.healthPort}`]);
    raw.tunnel = { clientPath: client, profile, profileDir, healthUrl: `http://127.0.0.1:${input.healthPort}` };
    const configTemp = path.join(stage, "config.pending");
    const envTemp = path.join(stage, "env.pending");
    await writeFile(configTemp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await writeFile(envTemp, newEnv, { mode: 0o600, flag: "wx" });
    if (await readOptional(configPath) !== original || await readOptional(envPath) !== oldEnv) throw new Error("配置在向导运行期间被修改，请重试；未覆盖其他修改。");
    await rename(envTemp, envPath);
    try { await rename(configTemp, configPath); }
    catch (error) {
      if (oldEnv === undefined) await rm(envPath);
      else await writeFile(envPath, oldEnv, { mode: 0o600 });
      throw error;
    }
    switched = true;
    await chmod(configPath, 0o600);
    await chmod(envPath, 0o600);
    progress("配置已保存到本机。工作区保持不变；现在可启动 Bridge 和 Tunnel。");
  } finally {
    if (stage && !switched) await rm(stage, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}
