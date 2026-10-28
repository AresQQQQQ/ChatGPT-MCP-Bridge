#!/bin/zsh -l
# Finder uses a login shell so the user's configured runtime PATH is available.
set -eu
cd -- "${0:A:h}"

if ! command -v node >/dev/null 2>&1; then
  print -u2 'Node.js 22+ is required. Install Node and configure your login-shell PATH.'
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print -u2 'Node.js 22+ is required.'
  exit 1
fi
if [[ ! -d node_modules/@modelcontextprotocol/sdk || ! -d node_modules/express ]]; then
  print -u2 'Dependencies are missing. Run: pnpm install --frozen-lockfile'
  exit 1
fi
if [[ ! -f dist/cli.js ]]; then
  print -u2 'Mac 控制台尚未构建，请先运行 pnpm run ui:build。'
  exit 1
fi
need_setup=0
[[ -f mcp-bridge.json && -f .env ]] || need_setup=1
if [[ "$need_setup" == "0" ]]; then
  node -e 'const c=JSON.parse(require("node:fs").readFileSync("mcp-bridge.json","utf8"));process.exit(c.tunnel ? 0 : 1)' || need_setup=1
fi
if [[ "$need_setup" == "1" ]]; then
  print 'Opening the graphical Tunnel setup wizard...'
  node dist/cli.js setup --config "$PWD/mcp-bridge.json"
  [[ -f mcp-bridge.json && -f .env ]] || exit 1
  node -e 'const c=JSON.parse(require("node:fs").readFileSync("mcp-bridge.json","utf8"));process.exit(c.tunnel ? 0 : 1)' || exit 1
fi
# Open the native Mac app. Its window owns the Bridge + Tunnel lifecycle.
exec node dist/cli.js ui --config "$PWD/mcp-bridge.json"
