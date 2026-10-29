import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("macOS Keychain helper keeps passwords off process arguments and uses the Security framework", async () => {
  const vault = await readFile(path.resolve("src/terminal/mac-keychain-vault.ts"), "utf8");
  const helper = await readFile(path.resolve("src/terminal/mac-keychain-helper.swift"), "utf8");
  const prompt = await readFile(path.resolve("src/terminal/local-password-prompt.ts"), "utf8");
  assert.match(vault, /spawn\(this\.helperPath, \[\]/u);
  assert.match(vault, /child\.stdin\.end\(Buffer\.from\(JSON\.stringify\(request\)/u);
  assert.doesNotMatch(vault, /spawn\([^\n]*password[^\n]*\]/iu);
  assert.match(prompt, /\/usr\/bin\/osascript/u);
  assert.match(prompt, /with hidden answer/u);
  assert.match(prompt, /MCP_BRIDGE_PASSWORD_CANCELLED/u);
  assert.match(helper, /import Security/u);
  assert.match(helper, /SecItemAdd/u);
  assert.match(helper, /SecItemUpdate/u);
  assert.match(helper, /SecItemCopyMatching/u);
  assert.match(helper, /SecItemDelete/u);
  assert.match(helper, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/u);
});

test("macOS Keychain helper type-checks against the native Security framework", { skip: process.platform !== "darwin" }, async () => {
  await execFileAsync("/usr/bin/xcrun", ["swiftc", "-typecheck", "-framework", "Security", path.resolve("src/terminal/mac-keychain-helper.swift")], { timeout: 120_000, maxBuffer: 16 * 1024 });
});
