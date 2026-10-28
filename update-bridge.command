#!/bin/zsh -l
set -euo pipefail
cd -- "$(dirname "$0")"

fail() { print -u2 -- "[ERROR] $*"; exit 1; }
command -v git >/dev/null 2>&1 || fail "Git is required."
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required."
command -v pnpm >/dev/null 2>&1 || fail "pnpm 11.19.0 is required."
[[ "$(pnpm --version)" == "11.19.0" ]] || fail "pnpm 11.19.0 is required."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "Node.js 22+ is required."
[[ -f mcp-bridge.json && -f .env ]] || fail "Local configuration is missing. Run pnpm run setup first."

branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || fail "Update is allowed only from branch main. Current branch: $branch"
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail "Working tree is not clean. No files were changed; commit or back up source edits first."
fi
port="$(node -e 'const c=JSON.parse(require("node:fs").readFileSync("mcp-bridge.json","utf8"));process.stdout.write(String(c.port || 3000))')"
if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "A process is listening on Bridge port $port. Stop the local Bridge/UI manually first; this script will not kill an unidentified process."
fi
print "[INFO] Fetching origin/main..."
git fetch origin
read -r ahead behind <<< "$(git rev-list --left-right --count HEAD...origin/main)"
[[ "$ahead" == "0" ]] || fail "Local main contains commits not present on origin/main. Refusing to overwrite or rebase them."
changed="$(git diff --name-only HEAD origin/main)"
needs_install=0
if print -r -- "$changed" | /usr/bin/grep -Eq '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
  needs_install=1
fi
if [[ "$behind" != "0" ]]; then
  print "[INFO] Fast-forwarding main by $behind commit(s)..."
  git merge --ff-only origin/main
else
  print "[INFO] Already at origin/main."
fi
if [[ "$needs_install" == "1" || ! -d node_modules/@modelcontextprotocol/sdk || ! -d node_modules/express ]]; then
  print "[INFO] Installing locked dependencies..."
  pnpm install --frozen-lockfile
fi
print "[INFO] Building TypeScript and native macOS UI..."
pnpm run ui:build
print "[INFO] Running local configuration/health diagnostics..."
node dist/cli.js doctor || fail "Doctor failed. Bridge was not started."
print "[INFO] Starting this machine's Bridge and its configured Tunnel. Press Ctrl+C to stop."
exec ./bridge.command