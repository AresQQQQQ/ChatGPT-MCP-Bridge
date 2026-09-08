# ChatGPT MCP Bridge

让 ChatGPT 通过 MCP 读取和编辑本地项目、检查 Git 差异、运行允许的开发脚本，并可选接入 Codex Desktop。

本仓库只发布 Bridge 自身，**不包含你的工作区配置、密钥、项目内容或热挂载的外部 MCP**。这是社区项目，与 OpenAI 官方产品分开维护。

[准备连接信息](#准备连接信息) · [安装启动](#安装启动) · [连接 ChatGPT](#连接-chatgpt) · [配置 ChatGPT 项目](#配置-chatgpt-项目) · [常见问题](#常见问题) · [手动配置](docs/SETUP.md) · [技术参考](docs/REFERENCE.md)

```text
ChatGPT 项目 → Bridge 应用 → Secure MCP Tunnel → 本机 Bridge → 指定的项目目录
```

## 准备连接信息

先准备下面两项，再运行安装向导。Platform 组织用于管理隧道与权限；ChatGPT 项目用于组织聊天，它们是不同的对象。

### Tunnel ID 从哪里获取

入口：[OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)。

1. 登录并切换到你要使用的 Platform 组织。
2. 创建一个隧道，或打开已有隧道，复制其 `tunnel_id`（以 `tunnel_` 开头）。
3. 将隧道关联到实际使用的 ChatGPT 工作空间，否则它可能不会出现在 ChatGPT 的连接列表中。

这个 ID 要填两处：**本地配置向导的 Tunnel ID**，以及 **ChatGPT 应用的 Tunnel 连接**。创建/管理隧道需要 Tunnels Read + Manage 权限，使用隧道需要 Read + Use。参见[官方隧道说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### Runtime API key 从哪里获取

入口：[OpenAI Platform → Runtime API keys](https://platform.openai.com/settings/organization/api-keys)。

1. 在同一个 Platform 组织中创建运行时 API key；创建密钥的身份需要 Tunnels Read + Use 权限。
2. 将密钥填入**本地配置向导的 Runtime API key** 提示。向导会将它保存为本机 `.env` 中的 `CONTROL_PLANE_API_KEY`。

不要使用 Admin API key，也不要把密钥填入 ChatGPT 项目指令或上传 GitHub。权限不足时联系组织管理员。

## 安装启动

### 1. 安装并运行向导

自动向导支持 **Windows x64 / ARM64**。准备 Node.js 22+、Git 和 pnpm；没有 pnpm 时先运行 `npm install -g pnpm`。其他系统可参考[手动配置](docs/SETUP.md)。

```powershell
git clone https://github.com/AresQQQQQ/ChatGPT-MCP-Bridge.git
cd ChatGPT-MCP-Bridge
pnpm install --frozen-lockfile
pnpm build
pnpm run setup
```

按提示填写上面的 Tunnel ID、Runtime API key，健康端口通常保持默认即可。密钥输入不会显示。也可以运行 `setup.cmd`；请使用 `pnpm run setup`，避免与 pnpm 自带的 `setup` 命令混淆。

向导自动下载官方客户端、校验 SHA-256 并生成 profile。新安装会创建本机配置；已有配置保留工作区、权限和认证令牌，默认复用现有客户端。向导只完成本地设置，ChatGPT 连接在后续步骤配置。

### 2. 指定本地项目

打开生成的 `mcp-bridge.json`，保留其他字段，将 `workspaces` 替换为实际项目。下面仅为字段片段：

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

| 字段 | 含义 |
| --- | --- |
| `id` | 自定义工作区标识；后续工具调用中的 `workspaceId` 必须与它一致 |
| `root` | 本机已存在的项目目录；Windows 路径建议使用 `/` |
| `mode` | `workspace` 允许受控读写，`readonly` 只读 |
| `allowedScripts` | 允许执行的 `package.json` 脚本名；非 Node 项目可设为 `[]` |

初始的 `default` / `.` 指向 Bridge 自身，使用前请改成目标项目。多个项目可添加不同 `id` 的条目。需要通用命令执行时才启用 `trusted-dev`，它以当前用户身份执行代码，不是操作系统沙箱。

### 3. 启动服务

```powershell
node dist/cli.js doctor
.\bridge.cmd
```

等待 Bridge 和 Tunnel 两个 `READY` 状态，保持进程运行。也可用 `bridge-ui.cmd` 打开 Windows 控制窗口。两个启动脚本在缺少配置文件时都会先进入向导。

## 连接 ChatGPT

1. 在 ChatGPT 网页端打开 **设置 → 安全与登录 → 开发者模式**。
2. 进入 **Plugins/插件**，通过加号创建开发者应用，名称可填 `ChatGPT MCP Bridge`。
3. 连接方式选择 **Tunnel**，选择已创建的隧道或填入其 `tunnel_id`。
4. 在对话输入框的加号菜单中选择开发者模式，启用这个应用。已有可用的 Bridge 应用时可复用。

入口名称和可用性以账号界面为准，参见[官方开发者模式指南](https://developers.openai.com/api/docs/guides/developer-mode)。不要把本机 `http://127.0.0.1:3000/mcp` 填成云端连接地址；本教程通过 Tunnel 接入。

## 配置 ChatGPT 项目

在 ChatGPT 创建项目，例如“我的应用开发”。打开项目菜单或设置，将下面模板粘贴到**项目指令**，替换应用名称及所有 `my-app`，再从项目内新建对话并启用 Bridge 应用。项目指令可供项目内聊天共享，参见[官方项目说明](https://learn.chatgpt.com/docs/projects)。

对应关系是：**项目指令中的 `workspaceId` → 本地 `workspaces[].id` → `root`**。ChatGPT 项目名称只是显示名称，不会自动绑定本地目录。

### 项目指令模板

也可使用[独立模板文件](docs/CHATGPT-PROJECT-INSTRUCTIONS.md)。

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

### 验证配置

在项目内发送：

```text
请使用 ChatGPT MCP Bridge 列出工作区，然后打开 my-app，确认根目录与权限，
读取项目说明并概括目录结构。只检查连接，不修改文件。
```

应看到真实工具调用，以及正确的工作区和路径。上传 README 或模板到项目“文件/来源”只提供上下文，不会自动建立 MCP 连接或实时同步源码。

**项目指令不是权限隔离。** 同一 Bridge 下的多个工作区可能被同一应用发现；需要隔离不同用户时，使用独立的 Bridge 配置、实例与连接。

## 常见问题

| 问题 | 检查方法 |
| --- | --- |
| 没有隧道权限或开发者模式入口 | 核对 Platform 组织权限与 ChatGPT 工作空间权限；两者分别管理 |
| ChatGPT 找不到隧道 | 检查目标工作空间关联，以及 Tunnels Read + Use 权限 |
| 下载失败或校验失败 | 检查 GitHub 网络访问，稍后重试或使用手动配置；安装器不会跳过校验 |
| 工具不可用、发现失败或 401/403 | 检查两个 READY 状态、应用是否启用及本地密钥；使用组合启动以传入 Bridge 认证头 |
| Unknown workspace 或目录错误 | 核对 `workspaceId`、`id` 和 `root`，修改本地配置后重启 Bridge |
| 命令被拒绝 | 检查工作区模式、允许的脚本名及脚本是否实际存在 |
| 需要重新配置或清理安装锁 | 先停止 Bridge，按[维护说明](docs/SETUP.md#本机文件与重新配置)操作 |

## 开发与进阶使用

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm export:source
```

- [手动配置与维护](docs/SETUP.md)：本机文件、重新配置、Codex Desktop、外部 MCP 和源码导出。
- [技术参考](docs/REFERENCE.md)：工具、执行权限、HTTP 认证和 Codex 任务模型。
