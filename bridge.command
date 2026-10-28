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
  print -u2 'Build is missing. Run: pnpm build'
  exit 1
fi
if [[ ! -f mcp-bridge.json || ! -f .env ]]; then
  print -u2 'Local configuration is missing. Run: pnpm run setup'
  exit 1
fi
# Replace the shell: Ctrl+C goes to the existing Bridge + Tunnel lifecycle.
exec node dist/cli.js start --config "$PWD/mcp-bridge.json"
