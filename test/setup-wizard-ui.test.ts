import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("setup command routes to the graphical wizard instead of terminal prompts", async () => {
  const cli = await readFile(path.resolve("src/cli.ts"), "utf8");
  const setupRunner = await readFile(path.resolve("tools/run-setup.mjs"), "utf8");
  const control = await readFile(path.resolve("src/ui/control-console.ts"), "utf8");
  assert.match(cli, /if \(command === "setup"\) return setupUi\(options\)/u);
  assert.match(control, /launchSetupUi\(configPath: string\)/u);
  assert.match(setupRunner, /dist\/cli\.js.*"setup"/u);
  assert.match(setupRunner, /src\/cli\.ts.*"setup"/u);
});

test("Windows setup wizard uses a password field and reports progress without showing the key", async () => {
  const source = await readFile(path.resolve("src/ui/windows-setup-wizard.ts"), "utf8");
  assert.match(source, /PasswordBox x:Name="RuntimeKeyBox"/u);
  assert.match(source, /x:Name="ProgressTitle"/u);
  assert.match(source, /x:Name="ProgressBar"/u);
  assert.match(source, /script:Token/u);
  assert.match(source, /Runtime API key/u);
});

test("Mac setup page includes the same local-only setup fields and progress feedback", async () => {
  const html = await readFile(path.resolve("assets/setup-wizard/index.html"), "utf8");
  const js = await readFile(path.resolve("assets/setup-wizard/setup.js"), "utf8");
  const css = await readFile(path.resolve("assets/setup-wizard/setup.css"), "utf8");
  for (const field of ["tunnel-id", "runtime-key", "health-port", "reuse-client"]) assert.ok(html.includes('id="' + field + '"'));
  assert.ok(js.includes("/api/setup"));
  assert.ok(js.includes("/api/snapshot"));
  assert.ok(js.includes("closeWizard"));
  assert.ok(css.includes(".progress-track"));
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

test("macOS has a Finder-friendly graphical setup entry point", async () => {
  const script = await readFile(path.resolve("setup.command"), "utf8");
  assert.match(script, /^#!\/bin\/zsh -l/u);
  assert.match(script, /tools\/run-setup\.mjs/u);
});