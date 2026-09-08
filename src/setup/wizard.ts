import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { setupTunnel } from "./tunnel-setup.js";

async function question(prompt: string, secret = false): Promise<string> {
  if (secret) process.stdout.write(prompt);
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  try { return (await rl.question(secret ? "" : prompt, { signal: abort.signal })).trim(); }
  catch { throw new Error("配置已取消。"); }
  finally { rl.close(); if (secret) process.stdout.write("\n"); }
}

export async function runSetupWizard(configPath: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在交互式终端运行 pnpm run setup 或 setup.cmd；不要把密钥放在命令行参数中。");
  if (process.platform !== "win32") throw new Error("自动配置向导目前支持 Windows x64 / ARM64；其他系统请按 README 手动配置。");
  let existing;
  try { await readFile(configPath); existing = await loadConfig(configPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  console.log("\nTunnel 配置向导\n请先在 Platform 创建隧道并关联 ChatGPT 工作空间。\n现有工作区保持不变；下载与 profile 保存在本机 .mcp-bridge-state。\n重新配置前请停止正在运行的 Bridge。Ctrl+C 取消。\n");
  const tunnelId = await question("Tunnel ID（tunnel_ 开头）：");
  const runtimeKey = await question("Runtime API key（输入不显示，留空保留本地已有密钥）：", true);
  const defaultPort = existing?.tunnel ? new URL(existing.tunnel.healthUrl).port || "8080" : "8080";
  const port = await question(`Tunnel 健康端口 [${defaultPort}]：`);
  let reuseClient = false;
  if (existing?.tunnel) reuseClient = (await question("复用已配置客户端？[Y/n]：")).toLowerCase() !== "n";
  await setupTunnel({ configPath, tunnelId, ...(runtimeKey ? { runtimeKey } : {}), healthPort: Number(port || defaultPort), reuseClient }, { progress: console.log });
  console.log("运行 .\\bridge.cmd 或 pnpm start 启动，然后在 ChatGPT 中连接对应 Tunnel。\n");
  return 0;
}
