# ChatGPT MCP Bridge

让 ChatGPT 通过 MCP 操作你明确授权的本地项目：读取与编辑文件、检查 Git 差异、运行项目脚本，并可选接入 Codex Desktop。

**本仓库仅包含 Bridge。热挂载的外部 MCP 实现、本机配置、密钥和运行数据均不随仓库发布。** 这是社区项目，与 OpenAI 官方产品分开维护。

[安装启动](#安装启动) · [连接 ChatGPT](#连接-chatgpt) · [配置 ChatGPT 项目](#配置-chatgpt-项目) · [项目指令模板](#项目指令模板) · [常见问题](#常见问题) · [英文技术参考](docs/REFERENCE.md)

```text
ChatGPT 项目对话 + 项目指令（workspaceId）
    → ChatGPT 中已连接的 Bridge 应用
    → Secure MCP Tunnel
    → 本机 Bridge（127.0.0.1:3000/mcp）
    → mcp-bridge.json 中明确配置的项目目录
```

## 能做什么

- 读取、搜索、编辑项目文件，查看图片和 PDF，下载文件到工作区。
- 检查 Git 状态与差异，执行受控暂存和本地提交。
- 运行允许的 package scripts 和本地配置的固定流程。
- 在 `trusted-dev` 模式下执行开发命令、启动桌面应用。
- 可选管理 Codex Desktop 的模块、对话和任务；可选代理独立运行的本地 MCP。

## 安装启动

### 1. 准备环境

需要 Node.js 22+、Git 和 pnpm。Windows 控制窗口、桌面启动和 Codex Desktop 集成面向 Windows；仅运行 HTTP Bridge 不依赖控制窗口。尚未安装 pnpm 时，可运行 `npm install -g pnpm`。

```powershell
git clone https://github.com/AresQQQQQ/ChatGPT-MCP-Bridge.git
cd ChatGPT-MCP-Bridge
pnpm install --frozen-lockfile
pnpm build
pnpm run setup
```

`pnpm run setup` 打开 Windows 交互式配置向导，也可双击 `setup.cmd`。先在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建隧道并关联目标 ChatGPT 工作空间，然后在向导中填写 Tunnel ID 和 Runtime API key（输入不会显示），健康端口默认按回车即可。

向导自动检测 x64 / ARM64、下载官方稳定版 ZIP、校验 SHA-256、提取客户端并生成独立 profile。新安装会生成 `mcp-bridge.json` 和随机本地认证令牌；已有配置只更新 `tunnel` 字段，保留工作区、权限和认证令牌。已有客户端默认复用，也可选择重新下载。**命令使用 `pnpm run setup`，以免与 pnpm 自带的 `setup` 命令混淆。**

### 2. 注册要操作的本地项目

打开 `mcp-bridge.json`，保留生成的 `auth`，将 `workspaces` 修改为实际项目。下面是 **workspaces 字段片段**，不是完整配置文件：

```json
"workspaces": [
  {
    "id": "my-app",
    "root": "D:/Projects/my-app",
    "mode": "workspace",
    "allowedScripts": ["test", "build", "lint", "typecheck"]
  }
]
```

先确认目录真实存在。Windows JSON 路径可使用 `/`，或将反斜杠写成 `\\`。初始化默认的 `default` / `.` 指向 Bridge 自身；需要操作别的项目时务必修改。

| 字段 | 怎么填 |
| --- | --- |
| `id` | 稳定标识，如 `my-app`；ChatGPT 的 `workspaceId` 必须与它完全一致 |
| `root` | 项目在运行 Bridge 的电脑上的目录，不是 GitHub URL |
| `mode` | 初次使用选 `workspace`；只读选 `readonly` |
| `allowedScripts` | 允许执行的 `package.json` 脚本名；非 Node 项目可设为空数组 |

`trusted-dev` 允许以当前用户身份执行真实命令，它不是操作系统沙箱。只在你信任的项目上主动启用。配置多个项目时，添加不同 `id` 的工作区条目。

### 3. 检查并启动

```powershell
node dist/cli.js doctor
.\bridge.cmd
```

等待 Bridge 和 Tunnel 两个 `READY` 状态，并保持进程运行。也可双击 `bridge-ui.cmd` 使用 Windows 控制窗口。首次运行这两个启动脚本时，若还没有 `mcp-bridge.json`，会先进入配置向导。

默认 MCP 地址是 `http://127.0.0.1:3000/mcp`。ChatGPT 云端不能直接访问这个本地地址；下一节说明如何在 ChatGPT 中连接已配置的隧道。仅需本地 HTTP Bridge 时，可使用 `node dist/cli.js init` 初始化，再用 `node dist/cli.js serve` 启动，无需 Tunnel。

## 连接 ChatGPT

### 1. 配置向导与本机文件

完成上一节向导后，可直接跳到“创建 ChatGPT MCP 应用”。向导不会代你创建云端隧道或修改 ChatGPT 账号设置。它的网络操作仅为下载客户端，保存完成也不表示 ChatGPT 已连接成功。

| 本机位置 | 内容 |
| --- | --- |
| `.mcp-bridge-state/tunnel-setup-*/` | 校验后的客户端、版本记录、独立 profile |
| `mcp-bridge.json` | Bridge 工作区及 `tunnel.clientPath`、`profileDir` 等配置 |
| `.env` | Runtime API key；留空输入可保留已有密钥 |

这些文件均已 Git 忽略，并排除在源码导出之外。密钥不会作为客户端命令行参数传递。`.env` 更新会保留其他变量的解析值，但会重新整理格式及移除注释。文件使用仅用户读写的 POSIX 模式保存；Windows 权限仍受所在目录 ACL 管理。

下载或 profile 初始化失败时不切换现有配置，临时文件会清理。重配前停止 Bridge，再运行 `pnpm run setup`；旧 profile 保留以免影响其他实例。若异常退出留下 `setup.lock`，先确认没有配置向导运行，再删除 `.mcp-bridge-state/setup.lock` 目录后重试。

<details>
<summary>手动配置（其他系统或不使用向导时）</summary>

已有配置时保留它；全新安装可先执行 `node dist/cli.js init`。

在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建隧道，关联目标 ChatGPT 工作空间，取得 `tunnel_id` 和 Runtime API key，并下载客户端。隧道权限与开发者模式权限分别管理。参见 [官方 Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

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

停止上一节的 `serve`（`Ctrl+C`），再启动组合服务，避免端口冲突：

```powershell
.\bridge.cmd
```

Bridge 会自动把本地 Bearer 认证头传给隧道客户端。等待 Bridge 与 Tunnel 两个 `READY` 状态，并保持进程运行。也可用 `.\bridge-ui.cmd` 打开 Windows 控制窗口。

</details>

### 2. 创建 ChatGPT MCP 应用

在 ChatGPT 网页端的 **设置 → 安全与登录 → 开发者模式** 开启功能。进入 **Plugins/插件**，通过加号创建开发者应用；连接方式选 **Tunnel**，选择隧道或填写 `tunnel_id`。应用可命名为 `ChatGPT MCP Bridge`。在对话输入框的加号菜单中选开发者模式，并启用该应用。参见 [官方开发者模式指南](https://developers.openai.com/api/docs/guides/developer-mode) 和 [隧道连接说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt)。入口名称可能随版本变化。

这里填的是隧道 ID，不是 `workspaceId` 或 Runtime API key。已有可用的 Bridge 应用时直接复用。

### 3. 验证工具可用

在启用应用的对话中发送：

```text
请使用 ChatGPT MCP Bridge 的 list_workspaces 工具列出可用项目，
再调用 get_workspace_info，workspaceId 为 my-app，确认根目录和权限。
只检查连接，不修改文件。
```

返回 `my-app` 和你配置的目录，才表示连接成功。应有真实工具调用结果；仅看到文字回复不代表成功。

## 配置 ChatGPT 项目

ChatGPT 项目、Platform API 项目和 Bridge 工作区是不同对象。本项目通过 **项目指令中的 workspaceId → 本地配置的 id → root** 对应，不会按 ChatGPT 项目名称自动绑定目录。ChatGPT 项目用于共享对话上下文和指令，参见 [官方项目说明](https://learn.chatgpt.com/docs/projects)。

1. 在 ChatGPT 创建一个项目，例如“我的应用开发”。
2. 打开该项目的菜单或设置，找到“项目指令”，粘贴下一节模板。
3. 把模板中所有 `my-app` 换成本地配置里的 `id`，把应用名称换成实际连接名称。
4. 在项目内新建对话，通过工具菜单启用 Bridge 应用，再执行连接验证。
5. 后续任务从该项目中发起；每个本地项目使用一份对应的项目指令。

| 填写位置 | 示例 | 用途 |
| --- | --- | --- |
| 本地 `workspaces[].id` | `my-app` | 工具请求的工作区标识 |
| 本地 `workspaces[].root` | `D:/Projects/my-app` | 实际读写目录 |
| ChatGPT 应用的 Tunnel 连接 | 你的 `tunnel_id` | 找到运行中的 Bridge |
| ChatGPT 项目名称 | 我的应用开发 | 显示名称，可自行命名 |
| ChatGPT 项目指令中的 `workspaceId` | `my-app` | 告诉模型使用哪个工作区 |

**项目指令是模型使用约定，不是权限隔离。** 同一 Bridge 配置多个工作区时，连接它的应用可能发现这些工作区；不同用户或共享项目需要隔离时，应使用独立配置、Bridge 实例和连接。

## 项目指令模板

复制整段到 ChatGPT 的“项目指令”，替换应用名称和所有 `my-app`。也可使用 [独立模板文件](docs/CHATGPT-PROJECT-INSTRUCTIONS.md)。不要上传 `.env`、认证令牌或完整本机配置。

```text
本项目使用的 MCP 应用：ChatGPT MCP Bridge
本项目固定的 workspaceId：my-app

处理本地代码与文件时，使用上述 Bridge 应用提供的工具。
每次新对话首次操作项目时：
1. 调用 get_workspace_info({"workspaceId":"my-app"})，确认工作区存在及当前权限。
2. 调用 open_workspace({"workspaceId":"my-app"})，读取返回的项目指令。
3. 后续需要 workspaceId 的工具调用均使用 my-app；路径填写相对项目根目录的路径。

默认只处理这个工作区。找不到它时报告配置问题，不自行换到另一个项目。
先读取相关文件再编辑，保留已有改动。代码变更后运行适用且被允许的检查，说明验证结果。
执行命令时优先使用已允许的项目脚本或固定 Recipe；权限不足时说明所需的本地配置。
若工具不可用或连接失败，明确报告，不编造文件内容、执行结果或成功状态。
不要读取、输出或上传密钥及本机认证配置。
Git 提交和推送遵循本次用户的明确要求；不要自行发布项目。
```

填写后可以发送第一条任务：

```text
请连接 my-app，读取项目说明并概括目录结构，告诉我如何启动和测试。先不要修改代码。
```

若也希望放入项目“文件/来源”，可上传替换完 `my-app` 的模板副本或项目 README；长期执行约定仍建议填写在“项目指令”。上传文件不会自动建立 MCP 连接或实时同步本地源码。

## 可选功能

**Codex Desktop：** 需要本机 Codex Desktop 可用并保持运行。在配置顶层添加 `"codex": {}`，目标工作区中添加 `"codex": {"enabled": true, "modules": {"general": "General"}}`。重启 Bridge、刷新应用工具列表后使用。先查询模块和已有对话，再明确选择创建或继续任务。详见 [Codex 任务模型](docs/REFERENCE.md#codex-task-model)。

**热挂载 MCP：** 外部服务独立安装、运行；Bridge 保存工作区下 `mcpServers` 的回环 HTTP 地址并代理调用。它们的实现和数据不在这个公开仓库内。不要把外部 MCP 工程复制到 `src` 或 `test`；如需放在仓库目录下，使用已忽略的 `local-mcps/` 或 `mounted-mcps/`。

## 常见问题

| 问题 | 检查方法 |
| --- | --- |
| 下载失败、GitHub 限流或校验失败 | 检查访问 api.github.com 和 GitHub 发布下载的网络；稍后重试。向导不会跳过校验或静默切换第三方镜像，也支持手动配置 |
| 向导提示需要交互式终端 | 使用终端中的 `pnpm run setup` 或 `setup.cmd`，不要通过日志管道或非交互任务输入密钥 |
| 没有开发者模式或 Tunnel 入口 | 核对账号/工作空间权限及当前官方文档；项目指令无法开启账号功能 |
| 隧道不在列表中 | 检查目标工作空间关联与 Tunnels Read + Use 权限 |
| 工具不可用或应用发现失败 | 保持 Bridge 和 Tunnel 运行，核对 READY 状态、profile、端口和本机 `.env` |
| 出现 401/403 | 保留生成的 `auth.token`；使用组合启动传入认证头。自建代理需正确处理 Host/Origin |
| 填写 localhost 不成功 | 云端不能访问本机回环地址；本教程使用 Tunnel |
| Unknown workspace | `workspaceId` 必须等于配置中的 `id`；初始化默认值为 `default` |
| 操作到了 Bridge 自身 | 默认 `root: "."` 指向配置所在目录；改成目标路径并重启 |
| 改了项目名称仍操作原目录 | 显示名称不参与绑定；同步修改工作区配置和项目指令 |
| 命令被拒绝 | 检查 `mode`、`allowedScripts` 和脚本是否存在；通用命令需明确启用 `trusted-dev` |

## 开发与发布内容

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm export:source
```

`export:source` 从 Git 工作区导出当前源码到 `release/`，包含未提交的源码改动，排除旧 Git 历史、本机配置、依赖和构建产物。使用源码 ZIP 时，若要再次导出，先在解压目录运行 `git init -b main`。

完整工具、权限边界、HTTP 认证和实现细节见 [英文技术参考](docs/REFERENCE.md)。实际授予模型的文件与执行权限由运行中的 Bridge 配置决定。
