import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("setup CLI entry opens the existing main console rather than a standalone wizard", async () => {
  const cli = await readFile(path.resolve("src/cli.ts"), "utf8");
  const control = await readFile(path.resolve("src/ui/control-console.ts"), "utf8");
  const windows = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  assert.match(cli, /if \(command === "setup"\) return ui\(options\)/u);
  assert.doesNotMatch(cli, /launchSetupUi|setupUi\(options\)/u);
  assert.match(control, /launchControlUi\(configPath: string\)/u);
  assert.doesNotMatch(control, /launchSetupUi/u);
  assert.match(windows, /x:Name="ConnectionWizardButton"/u);
  assert.match(windows, /x:Name="ConnectionSetupPopup"/u);
  assert.doesNotMatch(windows, /x:Name="ConnectionSetupPanel"/u);
  assert.match(windows, /TabItem Header="连接设置"/u);
  assert.match(windows, /x:Name="SaveConnectionSettingsButton"/u);
  assert.match(windows, /Start-ConnectionUiRequest '\/api\/connection\/setup'/u);
  assert.match(windows, /Start-ConnectionUiRequest '\/api\/connection\/settings'/u);
});

test("Windows main console embeds connection setup and keeps the Runtime API key in a password field", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  assert.match(source, /PasswordBox x:Name="SetupRuntimeKeyBox"/u);
  assert.match(source, /x:Name="SetupTunnelIdBox"/u);
  assert.match(source, /x:Name="SetupTunnelIdLockedPanel"/u);
  assert.match(source, /setup\.legacyTunnelIdUnknown/u);
  assert.match(source, /x:Name="SetupRuntimeKeyLockedPanel"/u);
  assert.match(source, /x:Name="SettingsTunnelIdBox"/u);
  assert.match(source, /https:\/\/platform\.openai\.com\/settings\/organization\/tunnels/u);
  assert.match(source, /https:\/\/platform\.openai\.com\/settings\/organization\/api-keys/u);
  assert.doesNotMatch(source, /x:Name="SetupBridgePortBox"/u);
  assert.doesNotMatch(source, /x:Name="SetupHealthPortBox"/u);
  assert.match(source, /Update-ConnectionSetup\(\$message\)/u);
  assert.match(source, /runConnectionSetup\(configPath,input/u);
  assert.match(source, /connectionSetup: Awaited<ReturnType<typeof readConnectionSetupStatus>>/u);
});

test("macOS main console embeds the same connection setup fields and posts to its existing action API", async () => {
  const html = await readFile(path.resolve("assets/mac-console/index.html"), "utf8");
  const js = await readFile(path.resolve("assets/mac-console/ui.js"), "utf8");
  const css = await readFile(path.resolve("assets/mac-console/ui.css"), "utf8");
  const server = await readFile(path.resolve("src/ui/mac-console.ts"), "utf8");
  for (const field of ["setup-tunnel-id", "setup-runtime-key", "settings-tunnel-id", "settings-bridge-port", "settings-health-port"]) {
    assert.ok(html.includes('id="' + field + '"'));
  }
  assert.ok(html.includes('id="connection-setup-panel"'));
  assert.ok(html.includes('id="setup-tunnel-id-locked"'));
  assert.ok(html.includes('id="setup-runtime-key-locked"'));
  assert.ok(html.includes("打开 Tunnel 管理页面") || html.includes("organization/tunnels"));
  assert.ok(html.includes("organization/api-keys"));
  assert.ok(!html.includes('id="setup-health-port"'));
  assert.ok(!html.includes('id="setup-bridge-port"'));
  assert.ok(html.includes('id="connection-setup-dialog"'));
  assert.ok(html.includes('id="connection-wizard"'));
  assert.ok(html.includes('id="settings-toggle"'));
  assert.ok(html.includes('id="settings-open-api-ports"'));
  assert.ok(html.includes('id="api-port-dialog"'));
  assert.ok(html.includes('id="settings-menu"'));
  assert.ok(html.includes("macOS Keychain 凭据管理尚未实现"));
  assert.ok(!html.includes('id="settings-open-connection"'));
  assert.ok(js.includes('command("connection-setup"'));
  assert.ok(js.includes('command("save-api-port-settings"'));
  assert.ok(js.includes('dialog.showModal()'));
  assert.ok(js.includes("state.legacyTunnelIdUnknown"));
  assert.ok(js.includes("renderConnectionSetup"));
  assert.ok(server.includes('action: z.literal("connection-setup")'));
  assert.ok(server.includes('action: z.literal("save-api-port-settings")'));
  assert.ok(server.includes("readConnectionSetupStatus(configPath, connectionSetupState)"));
  assert.ok(css.includes(".setup-dialog"));
});

test("first-run UI bootstraps a local config and reports missing connection requirements", async () => {
  const source = await readFile(path.resolve("src/ui/connection-setup.ts"), "utf8");
  const windows = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  const mac = await readFile(path.resolve("src/ui/mac-console.ts"), "utf8");
  assert.match(source, /export async function ensureUiBootstrapConfig/u);
  assert.match(source, /open\(absolute, "wx", 0o600\)/u);
  assert.match(source, /missingItems/u);
  assert.match(source, /Runtime API key/u);
  assert.match(windows, /await ensureUiBootstrapConfig\(configPath\)/u);
  assert.match(mac, /await ensureUiBootstrapConfig\(configPath\)/u);
});

test("macOS setup runner checks source timestamps without unresolved helpers and rebuilds stale native UI", async () => {
  const runner = await readFile(path.resolve("tools/run-setup.mjs"), "utf8");
  assert.match(runner, /import \{ readdirSync, statSync \} from "node:fs"/u);
  assert.match(runner, /function fileStat\(file\)/u);
  assert.match(runner, /function needsMacUiBuild\(\)/u);
  assert.match(runner, /pnpm", \["run", "ui:build"\]/u);
  assert.doesNotMatch(runner, /requireStat|awaitStat/u);
});

test("Windows setup session token is not passed as a command-line argument", async () => {
  const source = await readFile(path.resolve("src/ui/windows-setup-wizard.ts"), "utf8");
  assert.match(source, /BRIDGE_SETUP_TOKEN: server\.token/u);
  assert.match(source, /\$Token = \$env:BRIDGE_SETUP_TOKEN/u);
  assert.doesNotMatch(source, /"-Token", server\.token/u);
  assert.doesNotMatch(source, /"-ApiBase", server\.origin/u);
});

test("setup.command now routes into the main UI entry point", async () => {
  const script = await readFile(path.resolve("setup.command"), "utf8");
  const cmd = await readFile(path.resolve("setup.cmd"), "utf8");
  const cli = await readFile(path.resolve("src/cli.ts"), "utf8");
  assert.match(script, /^#!\/bin\/zsh -l/u);
  assert.match(script, /tools\/run-setup\.mjs/u);
  assert.match(cmd, /tools\\run-setup\.mjs/u);
  assert.match(cli, /if \(command === "setup"\) return ui\(options\)/u);
});

test("macOS connection wizard opens official acquisition links in the external browser", async () => {
  const swift = await readFile(path.resolve("src/ui/macos/BridgeControlApp.swift"), "utf8");
  assert.match(swift, /target\.host == "platform\.openai\.com"/u);
  assert.match(swift, /NSWorkspace\.shared\.open\(target\)/u);
  assert.match(swift, /decisionHandler\(\.cancel\)/u);
});
