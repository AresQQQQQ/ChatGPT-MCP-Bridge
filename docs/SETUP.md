# 手动配置与维护

首次安装优先使用[首页配置向导](../README.md#安装启动)。本文用于手动安装、重新配置和可选集成。

## 手动配置 Tunnel

已有配置时保留它；全新安装可先执行 `node dist/cli.js init`。

在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建隧道，关联目标 ChatGPT 工作空间，取得 `tunnel_id`，再到 [Runtime API keys 页面](https://platform.openai.com/settings/organization/api-keys) 创建运行时密钥，并下载客户端。隧道权限与开发者模式权限分别管理。参见 [官方 Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

用真实路径和 ID 替换下面的占位符，创建本地 HTTP profile（参数已按本项目使用的客户端帮助核对）：

```powershell
& "C:/Tools/tunnel-client.exe" init --profile bridge --tunnel-id "你的 tunnel_id" --mcp-server-url "http://127.0.0.1:3000/mcp" --health-listen-addr "127.0.0.1:8080"
```

在 `mcp-bridge.json` 顶层添加以下字段，注意与相邻字段用逗号分隔：

```json
"tunnel": {
  "clientPath": "C:/Tools/tunnel-client.exe",
  "profile": "bridge",
  "healthUrl": "http://127.0.0.1:8080"
}
```

首次使用时复制模板；已有 `.env` 时直接编辑，不要覆盖：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，仅在本地填写 `CONTROL_PLANE_API_KEY=你的 Runtime API key`。

若已单独运行 `serve`，先用 `Ctrl+C` 停止它，再启动组合服务，避免端口冲突：

```powershell
.\bridge.cmd
```

Bridge 会自动把本地 Bearer 认证头传给隧道客户端。等待 Bridge 与 Tunnel 两个 `READY` 状态，并保持进程运行。也可用 `.\bridge-ui.cmd` 打开 Windows 控制窗口。

## 本机文件与重新配置

| 本机位置 | 内容 |
| --- | --- |
| `.mcp-bridge-state/tunnel-setup-*/` | 校验后的客户端、版本记录、独立 profile |
| `mcp-bridge.json` | Bridge 工作区及 `tunnel.clientPath`、`profileDir` 等配置 |
| `.env` | Runtime API key；留空输入可保留已有密钥 |

这些文件均已 Git 忽略，并排除在源码导出之外。密钥不会作为客户端命令行参数传递。`.env` 更新会保留其他变量的解析值，但会重新整理格式及移除注释。文件使用仅用户读写的 POSIX 模式保存；Windows 权限仍受所在目录 ACL 管理。

下载或 profile 初始化失败时不切换现有配置，临时文件会清理。重配前停止 Bridge，再运行 `pnpm run setup`；旧 profile 保留以免影响其他实例。若异常退出留下 `setup.lock`，先确认没有配置向导运行，再删除 `.mcp-bridge-state/setup.lock` 目录后重试。

## 可选功能

**Codex Desktop：** 需要本机 Codex Desktop 可用并保持运行。在配置顶层添加 `"codex": {}`，目标工作区中添加 `"codex": {"enabled": true, "modules": {"general": "General"}}`。重启 Bridge、刷新应用工具列表后使用。先查询模块和已有对话，再明确选择创建或继续任务。详见 [Codex 任务模型](REFERENCE.md#codex-task-model)。

**热挂载 MCP：** 外部服务独立安装、运行；Bridge 保存工作区下 `mcpServers` 的回环 HTTP 地址并代理调用。它们的实现和数据不在这个公开仓库内。不要把外部 MCP 工程复制到 `src` 或 `test`；如需放在仓库目录下，使用已忽略的 `local-mcps/` 或 `mounted-mcps/`。

## 仅运行本地 HTTP Bridge

不需要 Tunnel 时，在全新配置下运行：

```sh
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js serve
```

已有配置时跳过 `init`。这个本地地址不能被 ChatGPT 云端直接访问。

## 导出源码

`pnpm export:source` 导出当前源码（含未提交的源码改动）到 `release/`，排除旧 Git 历史、本机配置、依赖及构建产物。若从 ZIP 解压后需要再次导出，先运行 `git init -b main`。
