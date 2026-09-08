# ChatGPT MCP Bridge

A small local development bridge. It exposes explicitly allowed project roots over MCP Streamable HTTP so ChatGPT can inspect, edit, diff, validate, and—when a workspace is explicitly marked `trusted-dev`—run real developer commands in the Bridge host's current user context.

The Bridge can supervise OpenAI's Secure MCP Tunnel client for a one-command local workflow. It also exposes bounded Git staging/commit operations and can optionally coordinate Codex Desktop while keeping workspace paths, task ownership, and execution policy under Bridge control. Existing Codex task turns are delivered through Desktop's local IPC owner; a short-lived app-server is retained only for bounded history/metadata operations and first-time thread creation. Normal `workspace` mode does not expose arbitrary shell access. `trusted-dev` intentionally adds trusted host developer execution and desktop-app launch capabilities; these are powerful user-authorized features, not OS sandboxes.

## Quick start

Install Node.js 22+, Git, and pnpm. From a fresh source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
```

Edit the generated `mcp-bridge.json` to allow only your project roots, then check and start the local MCP server:

```sh
node dist/cli.js doctor
node dist/cli.js serve
```

For the optional combined Bridge + Tunnel workflow, install the tunnel client separately and configure its path under `tunnel`. Copy `.env.example` to `.env` and set `CONTROL_PLANE_API_KEY` to your Runtime API key. On Windows, start both services with:

```bat
.\bridge.cmd
```

Wait for both `READY` lines, then connect your MCP client using your tunnel configuration. Press `Ctrl+C` to stop both services. Run `.\bridge-ui.cmd` for the Windows control UI. The local `.env` and `mcp-bridge.json` files are ignored by Git. Tunnel binaries, credentials, Codex Desktop, and external MCP servers are installed and configured separately.

## Repository contents and GitHub upload

This repository contains the Bridge source, tests, UI assets, dependency lockfile, and launch scripts. The Windows UI and Codex Desktop integration require Windows; the core HTTP Bridge can run separately.

Locally attached (hot-loaded) MCP servers are separate projects. Their implementations, dependencies, credentials, and data are **not included**. The generic proxy/registry code in `src/mcp/local-mcp-*.ts` belongs to the Bridge and is included. Server URLs under `workspaces[].mcpServers` stay in the ignored `mcp-bridge.json`; loaded/unloaded state stays in `.mcp-bridge-state/`. Keep external server projects outside this checkout, or under the ignored `local-mcps/` or `mounted-mcps/` directories.

To prepare a clean source folder for a new GitHub repository:

```sh
pnpm export:source
```

The command prints a new folder under `release/`. It copies current source files, including uncommitted changes, using an explicit project-file allowlist and Git ignore rules. It excludes `.git` history, local configuration, environment files (except `.env.example`), runtime state, installed dependencies, build output, test media, local MCP projects, and desktop probe data. Review that folder and upload its **contents**. Do not upload the entire working directory or use `npm pack` as a source export: that package is configured for compiled distribution.

For a normal Git push, review `git status` and the staged diff before committing. Ignore rules do not remove files or secrets already present in Git history. No GitHub remote or license choice is imposed by the export command.

## Requirements

- Node.js 22 or newer
- Git
- npm, pnpm, Yarn, or Bun for allowed package scripts

## Install and run

From a source checkout:

```sh
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js serve
```

The default endpoint is `http://127.0.0.1:3000/mcp`. `init` writes `mcp-bridge.json` with restrictive file permissions where the OS supports them and prints the generated token once. The token remains in that user-owned config; `serve`, `doctor`, health responses, and errors never print it.

## Configuration

All accessible roots must be listed explicitly:

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "mcpPath": "/mcp",
  "maxReadBytes": 1048576,
  "tunnel": {
    "clientPath": "C:/path/to/tunnel-client.exe",
    "profile": "web-test",
    "healthUrl": "http://127.0.0.1:8081"
  },
  "auth": {
    "token": "a-generated-base64url-token-of-at-least-32-bytes"
  },
  "codex": {
    "clientPath": "C:/path/to/codex.exe"
  },
  "workspaces": [
    {
      "id": "project",
      "root": "C:/work/project",
      "mode": "workspace",
      "allowedScripts": ["test", "build", "lint", "typecheck"],
      "codex": {
        "enabled": true,
        "modules": {
          "general": "General",
          "media": "Media / PDF"
        }
      }
    }
  ]
}
```

`tunnel` is only required by the combined `start` command. Its control-plane key is read from `.env` next to the config file, never from `mcp-bridge.json`. If the Bridge has a local bearer token, `start` automatically supplies it to the Tunnel client for MCP discovery and requests.

Relative roots are resolved from the config file directory. Workspace IDs, access modes, allowed package-script names, and Codex enablement are server-owned configuration; an MCP caller cannot upgrade them. `codex.clientPath` is optional when the local Codex runtime can be discovered automatically; it is used only by the short-lived app-server helper, not for normal Desktop-owned task turns. Bridge-owned Codex module/thread/task state is stored internally at `.mcp-bridge-state/codex.json`; that directory is Git-ignored and blocked from ordinary workspace MCP file access.

Codex conversations are scoped by the workspace's canonical root directory. Current generic Codex app-server APIs provide an exact `cwd` thread filter but do not expose Codex Desktop's saved-project identity as a stable project ID, so the Bridge intentionally uses canonical `workspaceId -> root` binding rather than guessing a Desktop project association.

Modes:

- `readonly`: read, list, search, and Git inspection only.
- `workspace`: read tools, controlled file writes, Git inspection, configured package scripts, and Controlled Recipes.
- `trusted-dev`: everything in `workspace`, plus `exec_dev_command` and `launch_desktop_app`. Commands run in the Bridge host's current user context; cwd remains workspace-contained, but the executed code itself is not sandboxed from the host OS.
- `handoff`: read, list, search, Git inspection, and project-instruction context; ordinary source writes and command execution are denied.

## MCP tools

- `open_workspace({ workspaceId })`
- `list_workspaces()`
- `get_workspace_info({ workspaceId })`
- `read_file({ workspaceId, path, offset?, limit? })`
- `list_directory({ workspaceId, path?, cursor?, limit? })`
- `search({ workspaceId, query, path?, maxResults?, maxDepth?, includeContent?, caseSensitive?, cursor? })`
- `stat_file({ workspaceId, path, includeHash? })`
- `find_files({ workspaceId, pattern, path?, maxResults?, maxDepth?, caseSensitive?, cursor? })`
- `apply_patch({ workspaceId, path, patch })`
- `write_file({ workspaceId, path, content })`
- `create_directory({ workspaceId, path })`
- `copy_file({ workspaceId, sourcePath, targetPath })`
- `move_path({ workspaceId, sourcePath, targetPath })`
- `delete_file({ workspaceId, path })`
- `delete_directory({ workspaceId, path })`
- `get_image({ workspaceId, path })`
- `get_pdf_info({ workspaceId, path })`
- `extract_pdf_text({ workspaceId, path, startPage?, endPage? })`
- `render_pdf_page({ workspaceId, path, page, maxDimension? })`
- `git_status({ workspaceId })`
- `git_diff({ workspaceId, path? })`
- `git_add({ workspaceId, paths? })`
- `git_commit({ workspaceId, message })`
- `git_log({ workspaceId, maxCount?, path? })`
- `git_show({ workspaceId, commitish?, path? })`
- `exec_command({ workspaceId, kind, name?, cwd? })`
- `list_recipes({ workspaceId })`
- `exec_recipe({ workspaceId, recipeId })`
- `exec_dev_command({ workspaceId, type, executable?, args?, shell?, command?, cwd?, timeoutMs? })` — `trusted-dev` only
- `launch_desktop_app({ workspaceId, target, args?, cwd? })` — `trusted-dev` only

When at least one workspace has `codex.enabled: true`, eleven additional tools are exposed:

- `codex_get_status()`
- `codex_list_modules({ workspaceId })`
- `codex_create_module({ workspaceId, moduleId, displayName })`
- `codex_update_module({ workspaceId, moduleId, displayName })`
- `codex_delete_module({ workspaceId, moduleId })`
- `codex_list_threads({ workspaceId, limit?, cursor?, archived? })`
- `codex_read_thread({ workspaceId, threadId })`
- `codex_submit_task({ workspaceId, moduleId?, threadId?, instruction, requestId? })`
- `codex_get_task({ workspaceId, taskId })`
- `codex_continue_task({ workspaceId, taskId, instruction, requestId? })`
- `codex_cancel_task({ workspaceId, taskId })`

Use `list_workspaces` when the configured IDs are not already known, then call `open_workspace`. It returns the selected ID, mode, allowed scripts, and bounded contents of root-level `AGENTS.md` and `CLAUDE.md` when present. Every later operation still requires and validates `workspaceId`; every file path and command cwd is workspace-relative. Search results can include a bounded matching-line preview. `list_directory`, `search`, and `find_files` return `truncated` plus an opaque `nextCursor` when traversal can continue. Pagination cursors retain bounded server-side directory traversal state so later pages resume instead of rescanning completed entries; cursors expire after five minutes, are single-use, and are invalidated by a Bridge restart. Large files can be read in bounded byte pages by passing `offset` and `limit`, then continuing from the returned `nextOffset` until `eof` is true. `stat_file` returns safe metadata and can optionally compute a SHA-256 content hash for regular files within the configured read limit. `find_files` supports bounded workspace-relative `*`, `?`, and `**` glob matching while preserving the same blocked-path and symlink rules. Directory deletion is non-recursive and moves never replace an existing target. Git inspection is read-only, while staging and local commit are exposed as separate bounded tools.

`git_show` returns the bounded commit patch when `path` is omitted. When `path` is supplied, it returns that file's contents at the selected revision, which is useful for comparing historical source without checking out or restoring files.

`apply_patch` accepts a unified diff for one target file or exact-match hunks such as:

```json
{
  "workspaceId": "project",
  "path": "src/example.ts",
  "patch": {
    "hunks": [
      { "oldText": "const enabled = false", "newText": "const enabled = true" }
    ]
  }
}
```

All hunks are validated before one atomic write. `write_file` is intended for new files or deliberate replacement; prefer `apply_patch` for existing code.

`exec_command` does not accept a command string, arbitrary arguments, environment variables, or an executable. `kind` is one of `test`, `build`, `lint`, `typecheck`, or `package-script`; the exact resulting package script must appear in that workspace's `allowedScripts`. The service uses `shell: false` at its process boundary, a canonical contained cwd, a sanitized environment, hard timeouts, byte output caps, and process-tree termination. Package scripts are project code, not an OS sandbox.

A **Controlled Recipe** is a locally configured fixed launcher/workflow selected only by `workspaceId + recipeId`. It improves repeatability, auditability, and invocation control; it does not make the project code itself safe or sandboxed.

`exec_dev_command` is available only in `trusted-dev`. It intentionally supports either a structured executable + argv request or an explicit Windows `cmd`/PowerShell command. It keeps cwd inside the selected workspace, preserves the normal developer environment, strips Bridge/Tunnel/control-plane secret variables, and retains timeout/output/process-tree controls. This is trusted host execution under the current Bridge user, not a security sandbox.

`launch_desktop_app` is also `trusted-dev` only. It launches a non-elevated process in the Bridge process's current user/session context with visible Windows desktop behavior (`windowsHide: false`), returns `launchId`, PID, and start time promptly, and does not attach the launched application to Bridge shutdown cleanup. It is intended for normal desktop/GUI applications such as Creo, browsers, or project UIs.

## Codex task model

Codex integration is deliberately narrower than the underlying protocols. ChatGPT supplies only `workspaceId`, a Bridge-owned `moduleId`, an optional explicit `threadId`, and an instruction; it cannot choose an arbitrary cwd, Codex home, executable, or raw Codex RPC/IPC method.

Each module has at most one current Codex conversation binding and has one of two lifecycle kinds. A `configured` module is a long-term work branch declared under `workspace.codex.modules`; it remains visible when unbound. A `temporary` module is created dynamically when ChatGPT submits a valid module ID that is not configured; it exists only while it has a live thread binding. Long-term modules can be created, renamed, and deleted through the Codex module management tools while the Bridge is running; these changes are persisted to the Bridge config and take effect immediately. Creating a long-term module with the same ID as an existing temporary module promotes it in place and preserves its live thread binding. Deleting a long-term module clears only the Bridge binding and never archives or deletes the Codex conversation. If a module is unbound, omitting `threadId` creates and binds a new conversation, while supplying one existing `threadId` binds that conversation. Once bound, ChatGPT must explicitly pass that same `threadId` to continue work; omitting it or supplying a different thread is rejected rather than silently creating or rebinding another conversation. `codex_continue_task` continues the exact thread recorded on the selected prior task. The `[ChatGPT]` prefix is retained in Bridge-managed thread/module names, not injected into the task body.

On Bridge startup, persisted bindings are reconciled against Codex's unarchived and archived thread lists. When a configured module's thread is archived, missing, or manually unbound, only the binding record is removed and the configured module remains visible as `unbound`. When the same happens to a temporary module, the temporary module disappears entirely. The Bridge never automatically unarchives a conversation. `codex_list_modules` performs the same read-only reconciliation before returning module state and refreshes the bound thread name plus current Desktop `ownerPresent` state. Task submission rechecks the binding again before execution so a thread archived after startup cannot be resumed accidentally.

State format v4 intentionally treats all pre-v4 module records as legacy and does not migrate their bindings. This one-time boundary removes the earlier test-era `e2e-*`/`flow-test` module records and stale bindings without deleting Codex conversations or persisted task history. Long-term modules are recreated from configuration; new runtime-only modules are persisted as `temporary` only while bound.

Normal task turns use Codex Desktop's `codex-ipc` follower path instead of a second app-server writer. When Codex support is enabled, Bridge startup also begins a non-fatal background IPC connection/reconnect loop. Once Desktop is reachable, the Bridge performs `thread-owner-discovery` only for thread IDs it already knows from its own records; this warm-up never opens, resumes, unarchives, or selects a conversation. `codex_get_status` exposes Desktop IPC connectivity, Bridge task counts, and those known owner states. `codex_list_threads` adds a live `ownerPresent` annotation to each listed thread while leaving the explicit task decision to ChatGPT.

If Desktop already owns the explicitly selected/newly created thread, the Bridge sends the turn directly to that owner. If the thread has no Desktop owner, the Bridge opens `codex://threads/<threadId>`, waits for Desktop to read/resume the thread and become owner, restores the previously foreground window on a best-effort basis, and then sends the turn. The deep-link itself briefly activates Codex Desktop; foreground restoration is a UX mitigation, not a hidden background-resume API. Archived threads are not silently unarchived: an explicitly selected archived thread is rejected so ChatGPT can choose another existing thread or omit `threadId` to create a new conversation. Codex Desktop must therefore be running and reachable for task execution on Windows.

The Bridge follows the Desktop-owned thread while a managed turn is active so it can observe the visible completion state and final agent response without acquiring the app-server writer lock. The Bridge enforces one active Codex task per workspace; tasks for other modules in the same workspace queue until the active turn completes. `requestId` provides caller-level deduplication for retried submissions. A submitted task returns immediately with a `taskId`; use `codex_get_task` to poll status and retrieve the final visible Codex response.

New-thread creation still requests workspace-write sandboxing and a non-interactive approval policy from the helper app-server. Task instructions are passed through without a Bridge-injected Git policy suffix; commit/push constraints belong to the caller's task instruction and the tools actually exposed to Codex. ChatGPT can independently inspect `git_diff`, files, PDFs/images, and configured checks before deciding whether to continue the Codex task or create the final local Git commit. Cancelling an active managed task is routed to the Desktop owner rather than starting another app-server writer.

`codex_list_threads` and `codex_read_thread` remain bounded, cwd-scoped app-server inspections; their helper process is closed immediately after each request so a read/list call does not retain a competing writer-capable runtime. Existing Codex threads are returned only when their reported canonical cwd exactly matches the selected workspace. Raw reasoning items are not intentionally surfaced by the task result path; the Bridge records the visible agent response and bounded task metadata.

## Security model

The bridge fails closed on security errors:

- roots are canonicalized when the server starts;
- inputs reject absolute paths, parent traversal, repeated separators, NUL/control characters, Windows drive-relative paths, UNC/device forms, ADS, and reserved device names;
- existing targets and parents are checked with `realpath` and must remain under the selected root;
- symbolic links and junctions are denied by default;
- new writes require an existing, canonical, contained parent;
- `.env`, `.env.*`, `.git`, `node_modules`, private-key names, `*.pem`, `*.key`, and common build/cache directories are blocked;
- Git uses fixed argv, disables external diff/textconv/pagers/prompts/optional locks, bounds output, and excludes sensitive/build paths;
- write tools and command execution are mode-gated on the server; `trusted-dev` is an explicit opt-in trusted-host execution mode rather than an OS sandbox;
- Git staging/commit is bounded and rejects blocked/sensitive staged paths; push, merge, checkout, reset, clean, fetch, and configuration changes are not exposed;
- Codex tasks are limited to explicitly Codex-enabled `workspace` roots and are cwd-verified before historical threads are returned;
- Codex task submission is serialized per workspace so multiple module threads do not write the same checkout concurrently.

This protects against unsafe MCP/model path and command input and reduces accidental blast radius in normal modes. It is not a defense against another malicious local process racing filesystem checks. `trusted-dev`, package scripts, Controlled Recipes, and Git worktrees are not OS sandboxes.

## HTTP authentication and exposure

The generated config requires `Authorization: Bearer <token>` even on loopback. The middleware validates an exact Host allowlist, an exact Origin when the client sends one, and the bearer token before JSON parsing or MCP dispatch.

Loopback is the default. A non-loopback bind fails to start without a strong token. For LAN/public use, also set exact values:

```json
{
  "host": "0.0.0.0",
  "allowedHosts": ["bridge.example.test"],
  "allowedOrigins": ["https://bridge.example.test"]
}
```

Do not expose the Node HTTP listener directly to the internet. Put it behind user-managed HTTPS and an authenticated, trusted reverse proxy or tunnel. V1 does not install or control Cloudflare Tunnel, ngrok, or similar services. The MCP client must support sending the bearer header; if a particular ChatGPT surface requires OAuth rather than a static header, place an OAuth-capable gateway in front or keep the bridge on a compatible client surface. See the official [ChatGPT Developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode) and [MCP server guide](https://developers.openai.com/plugins/build/mcp-server).

## CLI

```text
mcp-bridge init [--config path] [--force]
mcp-bridge serve [--config path] [--host host] [--port port]
mcp-bridge start [--config path] [--host host] [--port port]
mcp-bridge doctor [--config path] [--host host] [--port port]
```

`serve` starts only the local Bridge. `start` loads `.env`, starts the Bridge and configured Tunnel client, waits for `/readyz`, and supervises both until shutdown. `doctor` checks Node.js 22+, Git, required package managers, config validity, root readability, and the authentication/listening policy.

## Development and verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests cover containment, traversal, symlink escape, blocked files, workspace IDs, permission modes, authentication, patch atomicity, Git operations, command timeout, output limiting, process-tree termination, HTTP MCP handshake, Codex module-thread reuse, Bridge-managed thread naming, request deduplication, workspace writer serialization, cwd-scoped history, completion capture, and cancellation cleanup, plus a real file/Git end-to-end flow:

```text
MCP Client -> open_workspace -> read_file -> exec_command -> apply_patch -> git_diff
```
