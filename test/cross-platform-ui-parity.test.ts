import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("macOS exposes a global local-MCP overview using the shared registry and existing actions", async () => {
  const html = await readFile(path.resolve("assets/mac-console/index.html"), "utf8");
  const js = await readFile(path.resolve("assets/mac-console/ui.js"), "utf8");
  const server = await readFile(path.resolve("src/ui/mac-console.ts"), "utf8");
  const controller = await readFile(path.resolve("src/control/bridge-controller.ts"), "utf8");

  assert.match(html, /id="local-mcp-global"/u);
  assert.match(html, /id="global-mcp-dialog"/u);
  assert.match(html, /id="global-mcp-count"/u);
  assert.match(html, /id="overall-health"/u);
  assert.match(html, /id="settings-edit-codex-defaults"/u);
  assert.match(html, /id="codex-defaults-dialog"/u);
  assert.match(js, /function renderGlobalMcps\(/u);
  assert.match(js, /Bridge 正常 · Codex 未连接/u);
  assert.match(js, /运行中 · 链路不完整/u);
  assert.match(js, /snapshot\.localMcpServers/u);
  assert.match(js, /data-global-mcp="local-mcp-probe"/u);
  assert.match(js, /local-mcp-unload/u);
  assert.match(js, /local-mcp-load/u);
  assert.match(js, /save-codex-defaults/u);
  assert.match(server, /save-codex-defaults/u);
  assert.match(server, /codexDefaults: \{ defaultModel: input\.defaultModel, defaultEffort: input\.defaultEffort \}/u);
  assert.match(server, /getLocalMcpServers\(\)/u);
  assert.match(server, /local-mcp-load/u);
  assert.match(server, /local-mcp-unload/u);
  assert.match(server, /local-mcp-probe/u);
  assert.match(controller, /public async getLocalMcpServers\(/u);
  assert.match(controller, /public async probeLocalMcpServer\(/u);
});

test("cross-platform parity matrix records UI, API, and platform-service gaps", async () => {
  const matrix = await readFile(path.resolve("docs/CROSS_PLATFORM_UI_PARITY.md"), "utf8");
  assert.match(matrix, /MCP 全局挂载总览/u);
  assert.match(matrix, /Codex 默认模型 \/ 推理等级/u);
  assert.match(matrix, /SSH 主机 CRUD/u);
  assert.match(matrix, /平台服务缺失/u);
  assert.match(matrix, /验收原则/u);
});
