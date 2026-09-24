@echo off
setlocal
set "BRIDGE_NODE=node"
if exist "%~dp0runtime\node.exe" (
  set "PATH=%~dp0runtime;%PATH%"
  set "BRIDGE_NODE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 set "BRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "%~dp0node_modules\tsx\dist\cli.mjs" (
  echo Dependencies are missing. Run pnpm install once.
  exit /b 1
)
if not exist "%~dp0mcp-bridge.json" (
  call "%~dp0setup.cmd"
  if errorlevel 1 exit /b 1
)
"%BRIDGE_NODE%" "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\cli.ts" start --config "%~dp0mcp-bridge.json"
