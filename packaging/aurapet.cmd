@echo off
rem AuraPet launcher (Windows): start the headless daemon, then the Godot body.
rem Same layout as packaging/aurapet on Linux; both talk over loopback only.
setlocal EnableExtensions

set "LIB=%~dp0"
set "LIB=%LIB:~0,-1%"

if not defined AURAPET_CONFIG_DIR set "AURAPET_CONFIG_DIR=%APPDATA%\aurapet-desktop"
if not defined AURAPET_BRIDGE_PORT set "AURAPET_BRIDGE_PORT=47821"
if not defined AURAPET_UI_PORT set "AURAPET_UI_PORT=47830"
if not defined AURAPET_MCP_PORT set "AURAPET_MCP_PORT=47822"
if not defined AURAPET_APP_DIR set "AURAPET_APP_DIR=%LIB%"

if not exist "%AURAPET_CONFIG_DIR%" mkdir "%AURAPET_CONFIG_DIR%"

set "DAEMON_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p = Start-Process -FilePath '%LIB%\aurapet-daemon.exe' -PassThru -WindowStyle Hidden; $p.Id"`) do set "DAEMON_PID=%%P"
if not defined DAEMON_PID (
  echo aurapet: failed to start daemon 1>&2
  exit /b 1
)

rem The body reads the bridge token from the config file, so wait for the daemon
rem to write it (first run) before launching the window.
set /a tries=0
:wait_token
if exist "%AURAPET_CONFIG_DIR%\app-settings.json" (
  findstr /C:"bridgeToken" "%AURAPET_CONFIG_DIR%\app-settings.json" >nul 2>&1 && goto ready
)
set /a tries+=1
if %tries% GEQ 50 goto timeout
timeout /t 1 /nobreak >nul
goto wait_token

:timeout
echo aurapet: daemon did not write bridgeToken 1>&2
taskkill /PID %DAEMON_PID% /T /F >nul 2>&1
exit /b 1

:ready
rem AURAPET_BODY_ARGS is intentionally word-split for dev flags such as
rem "--no-tray --shot=%TEMP%\pet.png --shot-after=5".
"%LIB%\AuraPet.exe" -- "--config=%AURAPET_CONFIG_DIR%\app-settings.json" "--port=%AURAPET_BRIDGE_PORT%" "--ui-port=%AURAPET_UI_PORT%" %AURAPET_BODY_ARGS%
set "BODY_CODE=%ERRORLEVEL%"

taskkill /PID %DAEMON_PID% /T /F >nul 2>&1
exit /b %BODY_CODE%
