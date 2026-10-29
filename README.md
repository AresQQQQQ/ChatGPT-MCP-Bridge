# ChatGPT MCP Bridge

**让 ChatGPT 安全地使用你自己电脑上的开发工具和项目文件。**

ChatGPT MCP Bridge 是一个开源的本地桥接程序。它在你的电脑上运行，通过 Secure MCP Tunnel 将 ChatGPT 与你明确配置的本地工作区连接起来。你可以让 ChatGPT 读取项目、修改文件、检查 Git、运行允许的开发命令，并按需使用本地 MCP 和 Codex 集成。

- **Windows**：原生 WPF 控制台，支持 x64 / ARM64。
- **macOS**：原生 AppKit + WebKit 控制台，支持 Apple Silicon。
- **同一主线**：Windows 和 macOS 都从 GitHub 的 `main` 分支获取更新。

本项目由社区维护，**不是 OpenAI 官方产品**。仓库不包含你的项目文件、工作区配置、Tunnel profile、API key 或 SSH 密码。

## 第一次使用：按顺序完成这 5 步

如果你第一次接触这个项目，不需要先理解内部架构。按下面顺序操作即可。

### 第 1 步：准备环境

需要：

- [Node.js 22 或更高版本](https://nodejs.org/)
- [Git](https://git-scm.com/downloads)
- [pnpm](https://pnpm.io/installation)
- macOS 额外需要 Xcode Command Line Tools（用于编译原生控制台和 Keychain helper）。

在 macOS 上，如果尚未安装 pnpm，可以在 Terminal 执行：

```sh
npm install -g pnpm
```

Windows 用户请使用 PowerShell 或 Windows Terminal；Mac 用户请使用 Terminal。

### 第 2 步：下载并安装项目

在你希望保存源码的位置执行：

```sh
git clone https://github.com/AresQQQQQ/ChatGPT-MCP-Bridge.git
cd ChatGPT-MCP-Bridge
```

接下来按你的系统完成依赖安装：

- **Windows：** 首次启动前执行 `pnpm install --frozen-lockfile`。当前 Windows 启动脚本不会自动安装依赖。
- **macOS：** 无需手动执行安装命令。首次双击 `bridge-ui.command` 时，启动脚本会检查依赖，并在需要时自动执行锁文件安装。

完成后，继续下一步启动桌面 UI。

### 第 3 步：启动桌面 UI，并在 UI 中配置 Tunnel

启动桌面控制台：

- **Windows：** 双击项目根目录的 `bridge-ui.cmd`。
- **macOS：** 双击项目根目录的 `bridge-ui.command`。首次运行会按需安装依赖、构建原生 UI，并生成 Finder 可见的 `ChatGPT MCP Bridge.app`；之后也可以直接打开该 `.app`。

控制台打开后，点击「连接向导」，按提示填写 Tunnel ID、Runtime API key 和健康检查端口。向导会下载、校验并配置所需的官方 Tunnel 客户端。保存后回到主界面，先不要启动服务；下一步先添加工作区。

准备以下两项：

1. **Tunnel ID**：在 [OpenAI Platform 的 Tunnels 页面](https://platform.openai.com/settings/organization/tunnels) 创建或选择一个 Tunnel，复制它的 ID。
2. **Runtime API key**：在同一 Platform 组织的 [API keys 页面](https://platform.openai.com/settings/organization/api-keys) 创建运行时密钥。不要使用 Admin API key。

Tunnel 的管理权限与 ChatGPT 工作空间的使用权限是两回事。请确认 Tunnel 已关联到你准备使用的 ChatGPT 工作空间，并且你的账号具有所需的 Tunnels 权限。

> Runtime API key 供本机 Tunnel Client 连接控制平面使用。不要把它填进 ChatGPT 插件的认证栏，也不要提交到 GitHub。

### 第 4 步：在 UI 中添加你要访问的本地项目

Bridge 需要知道 ChatGPT 可以访问哪些目录。连接向导只负责 Tunnel 连接；项目目录请在桌面控制台的工作区管理中添加。一般不需要手动编辑 `mcp-bridge.json`。

每个工作区至少有三个关键字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 工作区唯一 ID；ChatGPT 工具调用中的 `workspaceId` 必须使用这个值 |
| `root` | 电脑上的项目目录绝对路径 |
| `mode` | 这个工作区允许的操作范围 |

常见权限模式：

- `readonly`：只读访问。
- `workspace`：在工作区范围内进行受控读写。
- `trusted-dev`：允许更多开发操作，例如运行开发命令和使用交互式终端。它**不是操作系统沙箱**，请只给可信的使用者。
- `handoff`：用于受控的交接工作流。

建议第一次先添加一个测试项目，并使用 `workspace` 模式。不要一开始就把整个用户目录或磁盘根目录开放给 Bridge。

添加完成后，回到主界面点击「启动服务」，确认 Bridge 和 Tunnel 都已启动并就绪。不要同时启动多份 Bridge，以免端口冲突。

### 第 5 步：在 ChatGPT 中创建 MCP 插件

确认桌面 UI 中的 Bridge 和 Tunnel 都已启动并就绪后，再在 ChatGPT 中完成一次连接器创建。**本机连接向导不会自动创建 ChatGPT 插件。**

还需要在 ChatGPT 中手动完成一次：

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)。
2. 点击添加入口，选择 **Add custom MCP server**。
3. 为连接命名，例如 `ChatGPT MCP Bridge)，Connection 选择 **Tunnel**。
4. 选择刚才配置的同一个 Tunnel，或输入相同的 Tunnel ID。
5. 按界面要求完成认证选项并创建插件。
6. 打开一个新对话，在输入框使用 `@` 选择该插件。

Tunnel ID 是用来选择连接的；Runtime API key 留在本机。不要把本机的 `http://127.0.0.1:3000/mcp` 直接填写成 ChatGPT 云端连接地址。本项目使用 Tunnel 连接。

官方说明：[在 ChatGPT 中连接自定义 MCP Server](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)。

## 第一次调用：确认连接正常

在 ChatGPT 中启用 Bridge 插件后，先做只读测试。你可以发送：

```text
请使用 ChatGPT MCP Bridge 检查工作区配置。
先列出可用工作区，再打开我刚添加的工作区，确认它的根目录和权限。
只读取项目说明并概括目录结构，不修改文件、不运行命令。
```

如果成功，你应该看到真实的 MCP 工具调用，并且返回的工作区 ID、目录和权限与本机配置一致。

如果工具不可用，请先检查：

1. 本机 Bridge 和 Tunnel 是否都已启动并就绪。
2. ChatGPT 中是否已创建并启用插件。
3. Tunnel 是否关联到当前 ChatGPT 工作空间。
4. 项目指令或工具调用中的 `workspaceId` 是否与本机的工作区 `id` 完全一致。

## 你可以用它做什么？

| 功能 | 用途 |
| --- | --- |
| 本地项目文件 | 浏览目录、读取和编辑工作区内的文件 |
| Git | 检查状态、查看差异，并按请求执行 Git 操作 |
| 开发命令 | 执行工作区允许的脚本或开发命令；具体权限取决于工作区模式 |
| 本地 MCP | 查看配置的本地 MCP，检测、加载和卸载服务 |
| Codex Desktop | 在配置启用且本机环境可用时，查看绑定、Threads 和任务状态并执行支持的任务操作 |
| 交互式终端与 SSH | 使用持久终端会话；管理全局 SSH 主机并调用保存的凭据 |
| 桌面控制台 | 查看 Bridge、Tunnel、MCP、Codex 的状态与日志，管理工作区和连接设置 |

### SSH 凭据与首次连接

SSH 主机资料和凭据在本机管理：

- Windows 将密码保存到 Windows Credential Manager。
- macOS 将密码保存到用户 Keychain。
- 密码不会写入 `mcp-bridge.json`、SSH 主机元数据、命令行参数或日志，也不会通过主机管理 API 返回。

使用保存的主机发起 SSH 连接时，Bridge 对首次遇到的主机采用 **TOFU（首次使用时信任）**：自动扫描并记录第一次看到的主机公钥，之后严格校验。如果已信任的密钥发生变化，连接会被拒绝，不会自动覆盖旧记录。

TOFU 不能独立证明首次扫描到的密钥一定属于目标设备。它适合你自己管理、且接受首次信任风险的设备；如果连接生产环境或不可信网络，请先通过可信渠道核实主机指纹。

## 更新到最新版本

Windows 和 macOS 都使用 GitHub 的 `main` 分支。

1. 正常停止本机 Bridge 和 Tunnel。
2. Windows 运行 `update-bridge.cmd`；macOS 运行 `./update-bridge.command`。
3. 按脚本提示完成更新和诊断，再启动控制台。

更新脚本会检查本地工作树和提交关系，只允许快进更新；如果本地有未提交改动，先保留或处理改动，不要直接覆盖。不要把本机配置、密钥和运行状态提交到 Git。

## 常见问题

### Tunnel 已就绪，但 ChatGPT 没有工具

Tunnel 就绪不代表 ChatGPT 插件已经创建。请完成上面的“在 ChatGPT 中创建 MCP 插件”，并确认插件已在当前对话中启用。

### ChatGPT 找不到 Tunnel

检查 Tunnel 是否属于正确的 Platform 组织、是否关联目标 ChatGPT 工作空间，以及当前账号是否具有 Tunnels Read + Use 等必要权限。

### 找不到工作区或目录不正确

确认 ChatGPT 使用的 `workspaceId` 与 `mcp-bridge.json` 中 `workspaces[].id` 完全一致，并检查对应的 `root` 是本机真实存在的绝对路径。

### 命令被拒绝

检查工作区的权限模式以及允许执行的脚本。不要把 `trusted-dev` 当成隔离沙箱；它可以执行更广泛的本机开发操作。

### Mac 控制台没有出现或无法启动

先在普通 Terminal 确认 Node.js、pnpm 和 Xcode Command Line Tools 可用，再双击 `bridge-ui.command`。如果应用仍在运行而需要重建，请先正常退出应用，再重新运行启动入口。

### SSH 首次连接失败或提示主机密钥变化

首次连接会自动记录主机密钥，但这不代表密码认证一定成功。若主机密钥变化，Bridge 会拒绝连接；请先通过可信渠道核实设备身份，不要为了绕过报错而关闭严格校验或直接覆盖旧记录。

## 进阶文档

如果你已经完成首次连接，需要了解详细配置或排查问题，请阅读：

- [手动配置、重新配置与本机文件](docs/SETUP.md)
- [工具、权限与技术参考](docs/REFERENCE.md)
- [交互式终端、SSH 凭据与安全限制](docs/INTERACTIVE-TERMINAL.md)
- [Windows/macOS UI 功能对等矩阵](docs/CROSS_PLATFORM_UI_PARITY.md)
- [ChatGPT 项目指令模板](docs/CHATGPT-PROJECT-INSTRUCTIONS.md)

## 开发与测试

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm build
```

macOS 原生控制台需要构建时，执行：

```sh
pnpm run ui:build
```

本项目使用 [Apache License 2.0](LICENSE)。第三方依赖及资源各自保留其适用许可证。
