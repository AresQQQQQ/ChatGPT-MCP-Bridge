@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
pushd "%ROOT%" || exit /b 1
where git >nul 2>nul || (echo [ERROR] Git is required. & exit /b 1)
where pnpm >nul 2>nul || (echo [ERROR] pnpm is required. Install pnpm 11.19.0. & exit /b 1)
for /f "delims=" %%V in ('pnpm --version') do set "PNPM_VERSION=%%V"
if not "%PNPM_VERSION%"=="11.19.0" (echo [ERROR] pnpm 11.19.0 is required; found %PNPM_VERSION%. & exit /b 1)
set "BRIDGE_NODE=node"
if exist "%ROOT%runtime\node.exe" (
  set "BRIDGE_NODE=%ROOT%runtime\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 set "BRIDGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "%ROOT%mcp-bridge.json" (
  echo [ERROR] Local mcp-bridge.json is missing. Run setup.cmd first.
  exit /b 1
)
"%BRIDGE_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22+ is required.
  exit /b 1
)
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not "%BRANCH%"=="main" (
  echo [ERROR] Update is allowed only from branch main. Current branch: %BRANCH%
  exit /b 1
)
for /f "delims=" %%S in ('git status --porcelain --untracked-files=all') do (
  echo [ERROR] Working tree is not clean. No files were changed.
  echo         Commit or back up source edits and remove untracked source files before updating.
  exit /b 1
)
for /f "delims=" %%P in ('powershell.exe -NoLogo -NoProfile -Command "$c=Get-Content -Raw mcp-bridge.json ^| ConvertFrom-Json; if($c.port){$c.port}else{3000}"') do set "BRIDGE_PORT=%%P"
if not defined BRIDGE_PORT set "BRIDGE_PORT=3000"
powershell.exe -NoLogo -NoProfile -Command "if(Get-NetTCPConnection -LocalPort %BRIDGE_PORT% -State Listen -ErrorAction SilentlyContinue){exit 1}else{exit 0}"
if errorlevel 1 (
  echo [ERROR] A process is listening on the configured Bridge port %BRIDGE_PORT%.
  echo         Stop this machine's Bridge/UI manually before updating; this script will not kill an unidentified process.
  exit /b 1
)
echo [INFO] Fetching origin/main...
git fetch origin
if errorlevel 1 exit /b 1
set "AHEAD="
set "BEHIND="
for /f "tokens=1,2" %%A in ('git rev-list --left-right --count HEAD...origin/main') do (
  set "AHEAD=%%A"
  set "BEHIND=%%B"
)
if not defined AHEAD (
  echo [ERROR] Could not determine local/remote commit relationship.
  exit /b 1
)
if not "%AHEAD%"=="0" (
  echo [ERROR] Local main contains commits not present on origin/main. Refusing to overwrite or rebase them.
  exit /b 1
)
set "NEED_INSTALL=0"
git diff --name-only HEAD origin/main | findstr /x /c:"package.json" /c:"pnpm-lock.yaml" /c:"pnpm-workspace.yaml" >nul
if not errorlevel 1 set "NEED_INSTALL=1"
if not "%BEHIND%"=="0" (
  echo [INFO] Fast-forwarding main by %BEHIND% commit(s)...
  git merge --ff-only origin/main
  if errorlevel 1 exit /b 1
) else (
  echo [INFO] Already at origin/main.
)
if "%NEED_INSTALL%"=="1" (
  echo [INFO] Dependency manifests changed; installing locked dependencies...
  call pnpm install --frozen-lockfile
  if errorlevel 1 exit /b 1
)
if not exist "%ROOT%node_modules\tsx\dist\cli.mjs" (
  call pnpm install --frozen-lockfile
  if errorlevel 1 exit /b 1
)
echo [INFO] Building Bridge...
call pnpm build
if errorlevel 1 exit /b 1
echo [INFO] Running local configuration/health diagnostics...
"%BRIDGE_NODE%" "%ROOT%dist\cli.js" doctor
if errorlevel 1 (
  echo [ERROR] Doctor failed. The Bridge was not started; see diagnostics above.
  exit /b 1
)
echo [INFO] Starting this machine's Bridge and its configured Tunnel. Press Ctrl+C to stop.
"%BRIDGE_NODE%" "%ROOT%dist\cli.js" start --config "%ROOT%mcp-bridge.json"
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%