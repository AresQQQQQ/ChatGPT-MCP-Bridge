#!/bin/zsh -l
# Finder uses a login shell so the user's configured runtime PATH is available.
# On first launch, prepare dependencies and build the ignored native .app locally.
set -euo pipefail
cd -- "${0:A:h}"

fail() { print -u2 -- "[ERROR] $*"; exit 1; }
info() { print -- "[INFO] $*"; }

command -v node >/dev/null 2>&1 || fail 'Node.js 22+ is required. Install Node.js and configure your login-shell PATH.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22+ is required.'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required for first launch. Install it with: npm install -g pnpm@11.19.0, then double-click bridge-ui.command again.'
[[ -f pnpm-lock.yaml ]] || fail 'pnpm-lock.yaml is missing; download the complete ChatGPT MCP Bridge source archive.'

APP_LINK="$PWD/ChatGPT MCP Bridge.app"
APP_BUNDLE="$PWD/.mcp-bridge-state/ChatGPT MCP Bridge.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/BridgeControl"
APP_INFO="$APP_BUNDLE/Contents/Info.plist"
CLI="$PWD/dist/cli.js"
HOST="$PWD/dist/ui/mac-app-host.js"
SWIFT_SOURCE="$PWD/src/ui/macos/BridgeControlApp.swift"
BUILD_SCRIPT="$PWD/tools/build-mac-ui.mjs"
MODULES_MARKER="$PWD/node_modules/.modules.yaml"

needs_install=0
if [[ ! -d node_modules/@modelcontextprotocol/sdk || ! -d node_modules/express || ! -d node_modules/tsx || ! -d node_modules/typescript || ! -f "$MODULES_MARKER" ]]; then
  needs_install=1
elif [[ package.json -nt "$MODULES_MARKER" || pnpm-lock.yaml -nt "$MODULES_MARKER" ]]; then
  needs_install=1
fi

needs_build=0
if [[ ! -f "$CLI" || ! -f "$HOST" || ! -x "$APP_EXECUTABLE" || ! -f "$APP_INFO" || ! -L "$APP_LINK" ]]; then
  needs_build=1
elif [[ "$SWIFT_SOURCE" -nt "$APP_EXECUTABLE" || "$BUILD_SCRIPT" -nt "$APP_EXECUTABLE" ]]; then
  needs_build=1
elif /usr/bin/find src -type f -newer "$CLI" -print -quit | /usr/bin/grep -q .; then
  needs_build=1
fi

# Never stop a running app or change its loaded build underneath it.
if [[ "$needs_install" == "1" || "$needs_build" == "1" ]]; then
  if [[ -x "$APP_EXECUTABLE" ]] && /usr/sbin/lsof -t "$APP_EXECUTABLE" >/dev/null 2>&1; then
    fail 'The Mac UI is already running and needs setup/build work. Quit the app yourself, then double-click bridge-ui.command again. This launcher will not close it.'
  fi
fi

if [[ "$needs_install" == "1" ]]; then
  info 'Installing locked dependencies for the first launch...'
  pnpm install --frozen-lockfile
fi

if [[ "$needs_build" == "1" ]]; then
  info 'Building the native Mac UI and generating the Finder app entry...'
  pnpm run ui:build
fi

[[ -f "$CLI" && -f "$HOST" && -x "$APP_EXECUTABLE" && -f "$APP_INFO" && -L "$APP_LINK" ]] || fail 'The UI build did not produce the expected app files. Review the build output and try again.'

info 'Opening ChatGPT MCP Bridge...'
# Open the native Mac app. Its window owns the Bridge + Tunnel lifecycle.
exec node dist/cli.js ui --config "$PWD/mcp-bridge.json"
