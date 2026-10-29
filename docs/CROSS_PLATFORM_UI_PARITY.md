# ChatGPT MCP Bridge 跨平台 UI 功能对等矩阵

## 审计范围

- Windows UI 基线：`integration/windows-macos-unified`，本地提交 `79a31e92770a0e84ad610f4e73d4aefd5f3aa221`。
- macOS UI 基线：本地提交 `f85500eebe87c3ce9a515f13a6509cedebf2d120`。相对 `79a31e9` 的差异仅涉及首次启动脚本、README、安装文档和测试，不包含控制台 UI 源码。
- 本矩阵比较用户可见功能、UI 控制接口和平台适配；不同原生 UI 技术栈本身不视为缺陷。
- 本轮为静态源码审计，不代表所有交互都已在两台机器上进行人工 E2E 验收。

## 结论摘要

当前项目共享 `BridgeController`、MCP 注册表、工作区配置和 Codex 绑定等核心能力，但两端 UI 的控制入口并不完全对等。Windows 使用 WPF + PowerShell 控制层；macOS 使用 AppKit + WebKit，并在 `src/ui/mac-console.ts` 独立定义 HTTP 操作 schema。共享核心不意味着新增的 UI 操作会自动出现在另一端。

## 功能对等矩阵

| 功能域 | Windows | macOS | 差异归类 | 状态 / 建议 |
|---|---|---|---|---|
| Bridge 生命周期 | 启动、停止 | 启动、停止、重启、关闭应用 | UI 交互差异 | 两端核心生命周期能力共享；Windows 缺少一键重启入口，低优先级 |
| 连接向导 | Tunnel ID、Runtime API、插件创建指引 | 同样具备 | 已对齐 | 继续共用连接配置逻辑 |
| 连接设置 | Runtime API、Tunnel ID、Bridge 端口、健康检查端口 | 同样具备 | 已对齐 | 两端都要求服务停止后保存 |
| 工作区列表与编辑 | 添加、删除、修改 ID/路径/权限模式，选择文件夹 | 同样具备 | 轻微 UX 差异 | Windows 添加时会选择文件夹并自动生成 ID；Mac 先创建空白草稿再填写。不是核心能力缺失 |
| 工作区权限模式 | readonly、workspace、trusted-dev、handoff | 同样具备 | 已对齐 | 保持模式定义和校验一致 |
| Module / Codex 绑定 | Module 详情、Thread、绑定状态、刷新、解除绑定 | 同样具备 | 已对齐 | 继续共享 Codex binding 业务逻辑 |
| MCP 全局挂载总览 | 顶部独立入口；汇总所有工作区 MCP、已加载数、检测状态、工具数、延迟和错误 | 已新增顶部“本地 MCP”入口与全局对话框，同时保留工作区级标签页 | UI 已补齐（本次实现，待 CI 验证） | 复用现有 snapshot 和检测 / 加载 / 卸载 API，不改核心生命周期语义 |
| MCP 检测 / 加载 / 卸载 | 全局列表中操作，检测、加载、卸载 | 当前工作区标签中操作，检测、加载、卸载 | 展示范围不同 | 核心后端已有能力；无需重写 BridgeController |
| MCP 探测详情 | 可用性、工具数量、延迟、错误 | 可用性、工具数量、延迟、错误 | 基本对齐 | 全局总览应复用已有 snapshot 字段 |
| 整体健康状态摘要 | 综合 Bridge、MCP、Tunnel、Codex 状态显示运行正常 / 部分链路未连接 | 已增加与 Windows 对应的聚合健康徽标，展示运行正常、Codex 未连接、链路不完整和服务异常 | UI 已对齐（当前规则镜像，待 CI 验证） | 后续可将规则进一步提取为共享状态契约，避免 PowerShell 与 JavaScript 逻辑漂移 |
| Codex 默认模型 / 推理等级 | 设置中可编辑并保存 | 已新增编辑对话框和 `save-codex-defaults` API；复用共享配置写入、模型/推理等级校验和 revision 冲突保护 | 已补齐（本次实现，待 CI 验证） | 保持停止服务后保存，并验证外部并发修改时拒绝覆盖 |
| SSH 主机 CRUD | 全局主机列表，新增、修改、删除、刷新、密码状态 | UI 明确说明 Keychain 凭据管理尚未实现；无等价主机 API | 平台服务缺失 | **P2：先实现 macOS Keychain adapter，再接统一 SSH host service/UI** |
| SSH 密码安全存储 | Windows Credential Manager | macOS Keychain adapter 尚未实现 | 平台适配差异 | 不得用明文配置或假 UI 代替；单独实现并测试安全存储 |
| 日志自动滚动 | 支持 | 支持 | 已对齐 | 保持行为一致 |
| 日志级别展示 | 独立级别列，警告/错误着色 | 根据等级着色，但没有独立的文字级别列 | UI 展示差异 | P2：Mac 增加可读级别标签，Windows 可考虑增加筛选 |
| 日志筛选 / 搜索 | 当前 UI 无同等的来源筛选、关键词搜索入口 | 支持来源筛选、关键词搜索 | Mac 更丰富 | 保留 Mac 优势；后续评估是否将筛选能力引入 Windows |
| 日志复制 / 清空视图 | 当前 UI 未发现对应入口 | 支持复制可见日志、清空当前视图 | Mac 更丰富 | 保留 Mac 优势；清空仅影响视图，不删除底层日志 |
| 项目配置冲突保护 | 使用配置快照键校验 | 使用 revision/hash 校验 | 实现不同、目标一致 | 增加契约测试验证两端均拒绝过期写入 |
| 原生目录选择器 | Windows 文件夹选择器 | macOS 原生文件夹选择器与目录访问书签 | 平台实现不同 | 合理的平台差异，不需要统一实现 |
| 应用凭据与原生启动 | Windows 原生桌面启动与 Credential Manager | macOS `.app` / `bridge-ui.command` 与目录授权书签 | 平台实现不同 | 合理的平台差异；共享首次启动文档与错误语义 |

## 代码依据

- Windows UI：`src/ui/windows-console.ts`，包含 `LocalMcpButton`、`LocalMcpPopup`、SSH 主机设置、Codex 默认值编辑和 `Update-OverallStatus`。
- macOS UI：`assets/mac-console/index.html`、`assets/mac-console/ui.js`。
- macOS 控制 API：`src/ui/mac-console.ts` 的 `save-config` 管理工作区；新增 `save-codex-defaults` action 管理全局 Codex 默认值；仍没有 SSH host CRUD action。
- 共享核心：`src/control/bridge-controller.ts` 已提供 `getLocalMcpServers`、`loadLocalMcpServer`、`unloadLocalMcpServer`、`probeLocalMcpServer`。
- 配置保存：`src/ui/workspace-config.ts` 的写入选项已支持 `codexDefaults`，因此 Codex 默认值差异主要在 Mac UI/API 接线和验证，不需要重写配置存储层。

## 修复顺序

1. **P0：Mac 全局 MCP 挂载总览。** 已补齐顶部入口、跨工作区汇总和现有检测 / 加载 / 卸载操作；待本次 CI 验证。复用 `snapshot.localMcpServers`，不改变后端服务生命周期语义。
2. **P1：统一整体健康状态摘要。** Mac 已补齐与 Windows 相同的聚合结论；后续可进一步把规则抽成共享状态契约，并为各异常状态增加对应原因说明。
3. **P1：Codex 默认值编辑。** 已新增独立的 `save-codex-defaults` action，复用 `revision` 检查和 `writeWorkspaceConfig`；待本次 CI 验证。
4. **P2：日志 UI 语义对齐。** 给 Mac 增加可见日志级别文字；Windows 日志筛选属于可选增强，不应因此削弱 Mac 已有功能。
5. **P2：macOS SSH host / Keychain。** 作为独立平台适配项目实现，完成 Keychain 安全存取后再开放 CRUD UI。

## 验收原则

- 新增通用功能时，必须同时更新本矩阵、两端 UI/API 和对应测试，或明确记录为平台专属。
- UI 按钮存在不等于功能完成；必须验证 action schema、后端操作、错误处理和状态刷新。
- 平台专属实现可以不同，但用户可见的能力、成功/失败语义和配置保护规则应保持一致。
- 不将只读显示误报为可编辑功能；不将 Tunnel 已连接误报为 ChatGPT 插件已创建或 MCP 调用成功。
