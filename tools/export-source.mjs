import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const rootFiles = new Set([
  ".env.example", ".gitignore", ".npmrc", "README.md", "LICENSE", "LICENSE.md",
  "bridge.cmd", "bridge-ui.cmd", "setup.cmd", "package.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.json", "tools/export-source.mjs",
]);
const listed = execFileSync("git", [
  "ls-files", "--cached", "--others", "--exclude-standard", "-z",
], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const candidates = [...new Set(listed)].filter((file) =>
  rootFiles.has(file) || /^(src|test|assets|docs)\//u.test(file),
);
// --no-index also checks tracked files against the current ignore policy.
const ignoreCheck = spawnSync("git", [
  "-c", "core.quotePath=false", "check-ignore", "--no-index", "--stdin", "-z",
], {
  cwd: root, input: candidates.join("\0") + "\0", encoding: "utf8",
});
if (ignoreCheck.error) throw ignoreCheck.error;
if (ignoreCheck.status !== 0 && ignoreCheck.status !== 1) {
  throw new Error(`Git ignore check failed: ${ignoreCheck.stderr}`);
}
const ignored = new Set(ignoreCheck.stdout.split("\0").filter(Boolean));

const files = [];
for (const file of candidates) {
  if (ignored.has(file)) continue;
  const source = path.resolve(root, file);
  let info;
  try { info = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const resolved = await realpath(source);
  const relative = path.relative(root, resolved);
  if (!info.isFile() || info.isSymbolicLink() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing non-file or external path: ${file}`);
  }
  files.push(file);
}

await mkdir(path.join(root, "release"), { recursive: true });
const output = await mkdtemp(path.join(root, "release", "chatgpt-mcp-bridge-"));
for (const file of files.sort()) {
  const target = path.join(output, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
}
console.log(`Exported ${files.length} files to ${output}`);
