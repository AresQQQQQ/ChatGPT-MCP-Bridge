import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("Windows console exposes global Codex model and reasoning effort controls", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");

  assert.match(source, /<TextBox x:Name="CodexDefaultModelBox"[^>]*ToolTip="例如 gpt-6-luna"/u);
  assert.match(source, /<ComboBox x:Name="CodexDefaultEffortBox"/u);
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.match(source, new RegExp(`<ComboBoxItem Content="[^"]+" Tag="${effort}"\/>`, "u"));
  }
  assert.match(source, /<Button x:Name="SaveGlobalConfigButton"/u);
  assert.match(source, /全局 Codex 默认值/u);
  const settingsPopup = source.match(/<Popup x:Name="SettingsPopup"[\s\S]*?<\/Popup>/u)?.[0] ?? "";
  assert.match(source, /<Button x:Name="SettingsButton"/u);
  assert.match(settingsPopup, /ElementName=SettingsButton/u);
  assert.match(settingsPopup, /CodexDefaultModelBox/u);
  assert.match(settingsPopup, /Text="推理等级"/u);
  assert.doesNotMatch(source, /努力等级/u);
  const connectionPanel = source.slice(source.indexOf('<Border Grid.Row="1" Style="{StaticResource PanelBorderStyle}"'), source.indexOf('<Grid Grid.Row="2" Margin="0,0,0,12">'));
  assert.doesNotMatch(connectionPanel, /CodexDefaultModelBox|CodexDefaultEffortBox/u);
});

test("Windows console keeps the settings entry available, blocks editing while Bridge runs, and reports only completed saves", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");

  assert.match(source, /\$codexDefaultModelBox\.IsReadOnly = -not \$enabled; \$codexDefaultEffortBox\.IsEnabled = \$enabled/u);
  assert.match(source, /if\(controller\.lifecycleState!=="stopped"\)\{configMessage="请先停止 Bridge 再保存配置"/u);
  assert.match(source, /expectedKey=\$script:lastConfigKey/u);
  assert.match(source, /await writeWorkspaceConfig\(configPath,payload\.workspaces,\{expectedKey:payload\.expectedKey,codexDefaults:payload\.codexDefaults\}\); configMessage="配置已保存"/u);
  assert.match(source, /catch\(error\)\{ configMessage=`保存失败/u);
});
