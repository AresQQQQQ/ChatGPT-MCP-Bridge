import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("Windows console does not start Bridge with unsaved workspace permissions", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");

  assert.match(
    source,
    /\$startButton\.IsEnabled = -not \$script:busy -and -not \$script:configDirty/u,
    "start button must stay disabled while workspace config is dirty",
  );
  assert.match(
    source,
    /if\(\$script:configDirty\)\{\$configStatus\.Text='有未保存修改，请先保存配置后再启动'/u,
    "start click must reject unsaved workspace config",
  );
  assert.match(
    source,
    /if\(\$enabled -and \$script:configDirty\)\{\$modeLabel \+= ' · 未保存'\}/u,
    "permission badge must distinguish an unsaved mode from the persisted active mode",
  );
  assert.match(
    source,
    /当前显示的是未保存配置；保存后才会用于下次启动。/u,
    "unsaved permission badge must explain that it is not active yet",
  );
});

test("Windows project tree labels permission mode and keeps the Module count visible", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  assert.match(source, /kindText=\$projectModeLabel;badgeVisibility='Visible'/u);
  assert.match(source, /badgeBrush=\$projectBadgeBrush;badgeForeground=\$projectBadgeForeground/u);
  assert.match(source, /\$moduleCountText = "\$\(\$workspaceBindings\.Count\) Modules"/u);
});

test("Windows log panel supports auto-follow and restores the previous scroll position when disabled", async () => {
  const source = await readFile(path.resolve("src/ui/windows-console.ts"), "utf8");
  assert.match(source, /x:Name="LogAutoFollow"/u);
  assert.match(source, /\$followLogs = .*IsChecked -eq \$true/u);
  assert.match(source, /ScrollToVerticalOffset/u);
});