@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

if not defined AURAPET_APP_DIR set "AURAPET_APP_DIR=%SCRIPT_DIR%"

if not defined AURAPET_CONFIG_DIR (
    if defined APPDATA (
        set "AURAPET_CONFIG_DIR=%APPDATA%\aurapet-desktop"
    ) else if defined USERPROFILE (
        set "AURAPET_CONFIG_DIR=%USERPROFILE%\AppData\Roaming\aurapet-desktop"
    ) else (
        set "AURAPET_CONFIG_DIR=%SCRIPT_DIR%\config"
    )
)

if not defined AURAPET_BRIDGE_PORT set "AURAPET_BRIDGE_PORT=47821"
if not defined AURAPET_UI_PORT set "AURAPET_UI_PORT=47830"
if not defined AURAPET_MCP_PORT set "AURAPET_MCP_PORT=47822"

if not exist "%AURAPET_CONFIG_DIR%" mkdir "%AURAPET_CONFIG_DIR%"

set "AURAPET_CONFIG_DIR=%AURAPET_CONFIG_DIR%"
set "AURAPET_APP_DIR=%AURAPET_APP_DIR%"
set "AURAPET_BRIDGE_PORT=%AURAPET_BRIDGE_PORT%"
set "AURAPET_UI_PORT=%AURAPET_UI_PORT%"
set "AURAPET_MCP_PORT=%AURAPET_MCP_PORT%"

start "" /b "%AURAPET_APP_DIR%\aurapet-daemon.exe"

set /a count=0
:wait_token
if %count% geq 50 goto start_body
if exist "%AURAPET_CONFIG_DIR%\app-settings.json" (
    findstr /C:"bridgeToken" "%AURAPET_CONFIG_DIR%\app-settings.json" >nul 2>&1
    if not errorlevel 1 goto start_body
)
timeout /t 1 /nobreak >nul 2>&1
set /a count+=1
goto wait_token

:start_body
"%AURAPET_APP_DIR%\AuraPet.exe" -- "--config=%AURAPET_CONFIG_DIR%\app-settings.json" "--port=%AURAPET_BRIDGE_PORT%" "--ui-port=%AURAPET_UI_PORT%" %AURAPET_BODY_ARGS%

taskkill /f /im aurapet-daemon.exe >nul 2>&1
