#!/bin/zsh -l
set -euo pipefail
cd -- "${0:A:h}"
command -v node >/dev/null 2>&1 || { print -u2 "Node.js 22+ is required."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { print -u2 "Node.js 22+ is required."; exit 1; }
[[ -d node_modules/tsx && -d node_modules/express ]] || { print -u2 "Dependencies are missing. Run pnpm install --frozen-lockfile first."; exit 1; }
exec node tools/run-setup.mjs --config "$PWD/mcp-bridge.json"