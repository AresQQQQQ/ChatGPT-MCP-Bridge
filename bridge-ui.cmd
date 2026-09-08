@echo off
setlocal

set "BRIDGE_ROOT=%~dp0"
set "BRIDGE_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "BRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    echo Node.js runtime was not found.
    echo Install Node.js 22 or make sure the bundled runtime is available.
    pause
    exit /b 1
  )
)

set "BRIDGE_TSX=%~dp0node_modules\tsx\dist\cli.mjs"
set "BRIDGE_CLI=%~dp0src\cli.ts"
set "BRIDGE_CONFIG=%~dp0mcp-bridge.json"

if not exist "%BRIDGE_CONFIG%" (
  call "%~dp0setup.cmd"
  if errorlevel 1 exit /b 1
)

if not exist "%BRIDGE_TSX%" (
  echo Dependencies are missing. Run pnpm install once.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$arguments = @($env:BRIDGE_TSX, $env:BRIDGE_CLI, 'ui', '--config', $env:BRIDGE_CONFIG); Start-Process -FilePath $env:BRIDGE_NODE -ArgumentList $arguments -WorkingDirectory $env:BRIDGE_ROOT -WindowStyle Hidden"
if errorlevel 1 (
  echo Failed to start MCP Bridge control UI.
  pause
  exit /b 1
)

exit /b 0
