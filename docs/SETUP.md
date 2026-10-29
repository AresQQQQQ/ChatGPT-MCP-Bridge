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

## 必需步骤：在 ChatGPT 创建 MCP 插件

**Tunnel ID 与 Runtime API key 只完成了本机 Tunnel 运行配置，不会自动在 ChatGPT 创建插件。** 本机 Bridge 与 Tunnel 启动并就绪后，还需要在 ChatGPT 完成一次连接器创建：

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击加号，选择 Add custom MCP server。
2. 输入名称，例如 ChatGPT MCP Bridge；Connection 选择 Tunnel。
3. 选择已有 Tunnel，或粘贴本机向导中使用的同一个 tunnel_id。
4. 认证通常选择无额外认证（No authentication）；确认风险提示，然后点击 Create as a plugin。Tunnel Client 会按本机 Bridge 配置处理本机连接认证。
5. 检查发现的工具；新建 ChatGPT 对话，使用 @ 选择插件，并调用一个安全的只读工具验证。

Runtime API key 只供本机 tunnel-client 连接 OpenAI 控制平面使用，不要把它填进 ChatGPT 插件的认证栏。Tunnel 的 Platform 组织权限与目标 ChatGPT 工作空间权限是分开的；若 Tunnel 不出现在列表中，检查它是否关联目标 ChatGPT workspace，以及操作者是否有 Tunnels Read + Use 权限。详细步骤见 [OpenAI 官方说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)。

## macOS Apple Silicon

Mac 版源码位于 `main` 分支。在 Mac 本地 SSD 上 clone 该分支，不在 SMB 共享盘运行依赖、Git 或 Tunnel：

```sh
git clone https://github.com/AresQQQQQ/ChatGPT-MCP-Bridge.git
cd ChatGPT-MCP-Bridge
pnpm install --frozen-lockfile
pnpm build
pnpm run setup
node dist/cli.js doctor
./bridge.command
```

Node 需要 22+。首次安装还应确认 pnpm 在普通 Terminal 中可用；如果只有 Codex 附带 pnpm，Finder 的登录 shell 无法发现它。本机已使用以下命令安装同版本到 Node 的标准全局位置，再从 Finder 启动的实例完成 package script 验证：

```sh
npm install -g pnpm@11.19.0
```

运行时通过 `process.execPath` 与登录 shell 的 PATH 发现。Apple Silicon Homebrew 的 `/opt/homebrew/bin` 场景已验证，不要求固定用户名或唯一安装目录。Finder 启动使用登录 shell；如果 shell 中未配置 Node，启动入口会给出明确提示。

pnpm run setup 会打开原生图形化 Tunnel 配置向导。输入 Tunnel ID、Runtime API key 和健康端口；已有 Runtime API key 可以留空以保留本机密钥。下载、SHA-256 校验和 profile 初始化进度会显示在向导中。

调整 `mcp-bridge.json` 的 `workspaces` 到实际绝对路径；启用 trusted-dev 时，Bridge 以本机当前用户运行开发命令。Bridge 项目自身的有效脚本是 `test`、`build`、`typecheck`。

停止使用 Ctrl+C；`pnpm start` 仍是标准组合启动方法。Windows 的三个 `.cmd` 启动入口与 WPF 控制台继续保留。Mac 图形控制台见下节。

本机健康检查：

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:8081/readyz
pnpm typecheck
pnpm test
pnpm build
```

安装器保留官方 GitHub origin、release download 路径、150 MiB ZIP 大小上限、bounded download 与 SHA-256 校验。macOS 使用系统 `/usr/bin/unzip` 读取唯一的固定文件名，输出大小受限，不让 ZIP 路径或符号链接决定安装路径；两个二进制设为 `0700`，清单为 `0600`。Windows 继续使用原 PowerShell ZIP 提取流程。

### Mac mini 实测记录（2026-10-03）

macOS 26.6.1 / arm64，Node v26.0.0，pnpm 11.19.0，Git 2.50.1。起点为 `bf1f502`。官方 Tunnel Client v0.0.15，asset 为 `tunnel-client-v0.0.15-darwin-arm64.zip`（27,018,754 字节），SHA-256：`b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff`。客户端与附带 cloudflared 均为 Mach-O arm64。首轮平台适配的 `pnpm typecheck/test/build` 均通过；145 个测试中 137 通过、8 个原有 Windows 专属测试跳过、0 失败。

实际完成交互式 `pnpm run setup`，使用原 Tunnel 和原 Runtime key，未创建新 Tunnel。本机 profile 为 `bridge`、健康端口为 8081。Bridge 与 Tunnel READY，`/health` 返回 `ok: true` 和 `bridgeCapabilityVersion: 7`；认证后的 MCP initialize 与 tools/list 返回 55 个工具，基础工作区/文件/Git、package script、trusted-dev 原生命令和四个分块写入工具均实际调用通过。

已实测 Finder 双击 `bridge.command`、从其他目录启动、启动期间与 READY 后的 SIGINT、SIGTERM、controller stop/restart、Tunnel 意外退出后的清理与再启动；这些路径关闭端口且没有孤儿 tunnel-client。`SIGKILL`、操作系统崩溃等无法运行进程内清理的情况不属于上述验证，强制终止后应检查残留进程。

ChatGPT 现有 `MCP Bridge Web Test App` 已刷新到本机的 55 个工具（Write 26 / Read 29），包含四个 v7 分块写入工具；使用同一个 Tunnel 完成远端工具发现，没有创建新应用或新 Tunnel。

Windows 的安装路径选择测试继续通过，Windows 三个启动脚本及 WPF 实现保留；当前 Mac 未执行 Windows 系统上的原生运行验证。Codex Desktop 的 Windows IPC 和 Windows 进程检查工具未在 Mac 上验证，不因平台安装适配而改变这些功能。

## Mac 图形控制台

Mac UI 使用 AppKit 原生窗口、系统 WebKit 和已有 Node/TypeScript 控制层，复用 Windows UI 的 BridgeController、工作区配置、Codex 绑定及本地 MCP 操作。未引入第三方桌面运行时。

显式构建需要 Xcode Command Line Tools（提供 swiftc、macOS SDK），启动已有应用不调用该工具链。构建和运行分别执行：

```sh
# 构建 TypeScript、Mac app、图标和 ad-hoc 签名：
pnpm run ui:build
# 只启动已有应用（以下任选其一）：
pnpm run ui
./bridge-ui.command
node dist/cli.js ui
```

运行入口不执行 tsc、swiftc、codesign 或构建脚本，也不根据源码 mtime 自动重建。应用可执行文件或 Node host 产物缺失时快速失败，提示“Mac 控制台尚未构建，请先运行 pnpm run ui:build。”源码修改后是否重建由用户明确执行 `ui:build` 决定。

构建产物实际位于 `.mcp-bridge-state/ChatGPT MCP Bridge.app`，项目根目录创建同名 Finder 可见链接；两者都 Git ignored。应用带有本机 ad-hoc 签名和图标，不是已公证的分发安装包。Finder 双击应用可直接打开独立窗口，不需要 Terminal 保持运行。首次会通过原生文件夹选择器确认此 Bridge 项目目录并保存目录访问书签，避免 Documents 目录权限阻塞启动；不请求完整磁盘访问。重新构建前先退出应用，避免运行期间改变签名。Node/依赖/构建产物仍在本机项目目录中；移动目录后重新执行构建。

- **连接链路：** ChatGPT、Tunnel、MCP、Bridge 与 Codex 状态，以及 PID、端口和启动时间。ChatGPT 节点表示 Tunnel 已就绪，不代表检测到了某个具体聊天正在调用。
- **服务：** 启动、停止和重新启动，⌘R 启动、⌘. 停止，⌘Q 或关闭窗口退出；⌘⇧R 重新载入控制台。
- **项目：** 项目/Module 选择、搜索、添加/移除配置、编辑 ID/路径/权限、原生 NSOpenPanel 文件夹选择。保存只在服务停止时允许，保留其他配置字段，并拒绝覆盖已被其他程序修改的配置。
- **Codex：** 显示当前绑定、长期/临时 Module、Thread 与 Desktop Owner，提供刷新和解除绑定。解除绑定保留对话。当前本机工作区未启用 Codex，这部分未做真实 Desktop IPC 操作验证。
- **本地 MCP：** 显示配置服务、加载状态、检测结果，支持检测、加载、卸载。检测/卸载/重新加载已通过临时回环 MCP 服务实际验证，测试配置随后清除。
- **日志：** 实时更新、来源/文本筛选、自动滚动、复制与清空视图；保留后端日志，显示内容已脱敏。浅色/深色样式随系统偏好，深色视觉尚未在本机切换系统外观实测。

控制 HTTP 监听器只绑定 `127.0.0.1` 的随机端口，使用每次启动随机凭据、固定 Host/Origin 检查、严格动作 schema 与 CSP；不提供通用命令执行接口。界面快照不包含 `.env`、原始配置或 Tunnel profile。WebKit 只允许当前回环 origin 的页面导航，原生文件夹选择消息仅接受主页面。

应用通过 stdin pipe 拥有 Node 控制进程；正常退出会等待服务清理，原生父进程退出导致 pipe EOF 时也会停止服务。已实测原生窗口中的启动/停止/重启、配置保存、文件夹选择与 ⌘Q 清理；自动测试覆盖 pipe EOF 清理。操作系统崩溃或直接 SIGKILL Node 控制进程不保证执行进程内清理。

最终 Mac UI 验证：153 个测试中 145 通过、8 个原有 Windows 专属测试跳过、0 失败；typecheck、build、原生 arm64 编译与签名校验通过。Finder 首次确认目录及随后复用目录书签的启动均已实测；最终 Finder 实例再次通过认证 MCP initialize/tools/list 和工作区、Git、package script、trusted-dev、分块写入调用。

UI 打开时默认处于停止状态，先点击“启动服务”。应用不接管其他实例拥有的服务。若端口已被占用，先退出旧 Terminal 或 UI；不要同时启动多份 Bridge。关闭图形应用后仍可使用原有 `bridge.command` / `pnpm start`。

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
