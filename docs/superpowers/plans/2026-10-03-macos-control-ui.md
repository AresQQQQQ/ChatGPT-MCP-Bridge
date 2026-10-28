# macOS Control UI Implementation Plan

**Goal:** Adapt the existing Windows console's service controls, project/module navigation, local MCP management and logs for Mac without replacing the Bridge/MCP architecture.

**Architecture:** An AppKit/WebKit standalone .app owns a loopback-only UI host delegates all service operations to BridgeController and all workspace writes to the existing configuration helper. The embedded WebKit view uses a per-launch UI credential, strict Host/Origin checks and fixed validated commands; real Tunnel/key/profile data stay server-side. UI matches Windows information hierarchy while using Mac typography, compact controls and responsive layout. Window form can be changed without changing the shared control API.

- [x] Add failing tests for UI endpoint authentication/CSRF, secret-free snapshots, controlled commands, concurrent workspace editing and service cleanup.
- [x] Implement the local control host and reuse existing lifecycle, Codex binding and local MCP operations.
- [x] Implement Mac console with service chain, project/module tree, editable project details, local MCP controls and live filtered logs.
- [x] Route pnpm run ui to the native .app by platform and add Finder bridge-ui.command; preserve Windows WPF and Terminal startup.
- [x] Verify typecheck/full tests/build, real UI service start/stop/restart, config edits without losing policy, logs and responsive layout.
- [x] Update docs and source export; scan reviewable files for actual private credentials and record known limitations.

User selected a standalone Mac application and authorized a new GUI technology choice. Implemented an AppKit window with native menu/NSOpenPanel and a nonpersistent WKWebView; stdin pipe ownership cleans Node/Bridge/Tunnel on app exit. Built locally with the existing Swift toolchain, signed ad-hoc, and exposed an ignored Finder-visible .app link. No Electron/Tauri dependency added.

Verification: typecheck/build/native arm64 compile/ad-hoc signature passed. 153 tests: 145 passed, 8 Windows-only skips, 0 failures. Native UI start/stop/restart, exact-folder picker, config save with policy preservation, temporary real local MCP probe/unload/load, Cmd+Q and window-close cleanup passed. Finder launch initially blocked by Documents TCC; fixed with explicit project-folder selection and persisted security-scoped bookmark, then verified Finder relaunch without re-prompt. Clean source export contains native sources/UI assets and excludes local app/auth/state.
