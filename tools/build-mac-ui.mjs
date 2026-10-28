import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, stat, symlink, lstat, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("原生 Mac 控制台构建需要 macOS Apple Silicon。");
const source = path.join(root, "src/ui/macos/BridgeControlApp.swift");
const bundle = path.join(root, ".mcp-bridge-state/ChatGPT MCP Bridge.app");
const contents = path.join(bundle, "Contents");
const executable = path.join(contents, "MacOS/BridgeControl");
const running = await exec("/bin/ps", ["-axo", "comm"], { timeout: 5_000 });
if (running.stdout.split("\n").some(line => line.trim() === executable)) {
  throw new Error("请先退出 Mac 控制台，再重建应用；运行期间不修改应用签名。");
}

await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
await mkdir(path.join(contents, "Resources"), { recursive: true, mode: 0o700 });
const info = await stat(executable).catch(() => undefined);
if (!info || (await stat(source)).mtimeMs > info.mtimeMs) {
  try {
    await exec("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O", "-target", "arm64-apple-macos13.0", source, "-o", executable, "-framework", "AppKit", "-framework", "WebKit"], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  } catch (error) { throw new Error(`Mac 应用编译失败；请确认已安装 Xcode Command Line Tools。${error.stderr ?? ""}`); }
  await chmod(executable, 0o755);
}
const escape = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ChatGPT MCP Bridge</string>
<key>CFBundleDisplayName</key><string>ChatGPT MCP Bridge</string>
<key>CFBundleIdentifier</key><string>local.chatgpt-mcp-bridge.control</string>
<key>CFBundleExecutable</key><string>BridgeControl</string>
<key>CFBundleIconFile</key><string>Bridge.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>BridgeProjectRoot</key><string>${escape(root)}</string>
</dict></plist>\n`);
await copyFile(path.join(root, "assets/icons/chatgpt-mcp-bridge.png"), path.join(contents, "Resources/bridge.png"));
const iconFile = path.join(contents, "Resources/Bridge.icns");
const iconSource = path.join(root, "assets/icons/chatgpt-mcp-bridge.png");
if (!(await stat(iconFile).catch(() => undefined))) {
  const iconset = path.join(root, ".mcp-bridge-state/mac-ui.iconset");
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await exec("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), iconSource, "--out", path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { timeout: 30_000 });
    }
  }
  await exec("/usr/bin/iconutil", ["--convert", "icns", "--output", iconFile, iconset], { timeout: 30_000 });
}

await exec("/usr/bin/codesign", ["--force", "--sign", "-", bundle], { timeout: 30_000 });
const visibleApp = path.join(root, "ChatGPT MCP Bridge.app");
const relativeBundle = path.relative(root, bundle);
const existingApp = await lstat(visibleApp).catch(() => undefined);
if (!existingApp) await symlink(relativeBundle, visibleApp);
else if (!existingApp.isSymbolicLink() || await readlink(visibleApp) !== relativeBundle) {
  throw new Error("项目根目录已有其他 ChatGPT MCP Bridge.app；未覆盖该文件。");
}
console.log(`Mac 应用已构建：${visibleApp}`);
