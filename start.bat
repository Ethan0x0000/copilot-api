@echo off
setlocal EnableExtensions

REM ================================================================
REM copilot-api Windows bootstrap -> Debian dispatcher deployer
REM
REM This script deploys a VPS shell dispatcher named `copilot-api`
REM and creates global aliases: `copilot-api` and `capi`.
REM
REM Usage:
REM   start.bat install         ^(default^)
REM   start.bat start^|stop^|restart^|status
REM   start.bat logs [N]
REM   start.bat accounts
REM   start.bat accounts-status
REM   start.bat account list
REM   start.bat api accounts
REM   start.bat uninstall
REM ================================================================

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=install"

REM ----- Required configuration (can be overridden by environment) -----
if "%VPS_HOST%"=="" set "VPS_HOST=YOUR_VPS_HOST"
if "%VPS_USER%"=="" set "VPS_USER=root"
if "%VPS_PORT%"=="" set "VPS_PORT=22"

if "%SERVICE_NAME%"=="" set "SERVICE_NAME=copilot-api"
if "%SERVICE_USER%"=="" set "SERVICE_USER=root"
if "%SERVICE_PORT%"=="" set "SERVICE_PORT=4141"

if "%REMOTE_DIR%"=="" set "REMOTE_DIR=/opt/copilot-api"
if "%REMOTE_HOME%"=="" set "REMOTE_HOME=/var/lib/copilot-api"
if "%DISPATCHER_NAME%"=="" set "DISPATCHER_NAME=copilot-api"
if "%GLOBAL_ALIAS%"=="" set "GLOBAL_ALIAS=capi"
if "%CORE_BINARY_NAME%"=="" set "CORE_BINARY_NAME=copilot-api-core"

if /I "%ACTION%"=="help" goto :help
if /I "%ACTION%"=="install" goto :install
goto :dispatcher

:install
if /I "%VPS_HOST%"=="YOUR_VPS_HOST" (
  echo [ERROR] Please set VPS_HOST before install.
  echo         Example:
  echo         set VPS_HOST=1.2.3.4 ^&^& start.bat install
  exit /b 1
)

call :check_cmd bun || exit /b 1
call :check_cmd ssh || exit /b 1
call :check_cmd scp || exit /b 1

echo ================================================================
echo Building Linux binary...
echo ================================================================
if not exist node_modules (
  bun install || exit /b 1
)
bun build --compile --minify --target=bun-linux-x64 --outfile=%CORE_BINARY_NAME% src/main.ts || exit /b 1

if not exist "%CORE_BINARY_NAME%" (
  echo [ERROR] Build output "%CORE_BINARY_NAME%" not found.
  exit /b 1
)

set "DISPATCHER_FILE=%TEMP%\%DISPATCHER_NAME%"
call :write_dispatcher "%DISPATCHER_FILE%" || exit /b 1

echo ================================================================
echo Uploading core binary and dispatcher script...
echo ================================================================
scp -P %VPS_PORT% "%CORE_BINARY_NAME%" "%VPS_USER%@%VPS_HOST%:/tmp/%CORE_BINARY_NAME%" || exit /b 1
scp -P %VPS_PORT% "%DISPATCHER_FILE%" "%VPS_USER%@%VPS_HOST%:/tmp/%DISPATCHER_NAME%" || exit /b 1

echo ================================================================
echo Installing dispatcher and provisioning service...
echo ================================================================
ssh -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "sudo install -d -m 755 '%REMOTE_DIR%' '%REMOTE_DIR%/bin' '%REMOTE_HOME%' && sudo install -m 755 '/tmp/%CORE_BINARY_NAME%' '%REMOTE_DIR%/bin/%CORE_BINARY_NAME%' && sudo install -m 755 '/tmp/%DISPATCHER_NAME%' '%REMOTE_DIR%/%DISPATCHER_NAME%' && sudo '%REMOTE_DIR%/%DISPATCHER_NAME%' install && sudo rm -f '/tmp/%CORE_BINARY_NAME%' '/tmp/%DISPATCHER_NAME%'" || exit /b 1

del /q "%DISPATCHER_FILE%" >nul 2>nul

echo.
echo [OK] Dispatcher deployed.
echo [OK] Global commands on VPS: copilot-api / %GLOBAL_ALIAS%
echo.
echo Use from anywhere on VPS:
echo   %GLOBAL_ALIAS% status
echo   %GLOBAL_ALIAS% logs
echo   %GLOBAL_ALIAS% accounts
echo   %GLOBAL_ALIAS% accounts-status
echo.
echo Endpoints:
echo   http://%VPS_HOST%:%SERVICE_PORT%/accounts
echo   http://%VPS_HOST%:%SERVICE_PORT%/accounts/status
echo.
exit /b 0

:dispatcher
if /I "%VPS_HOST%"=="YOUR_VPS_HOST" (
  echo [ERROR] Please set VPS_HOST first.
  exit /b 1
)
call :check_cmd ssh || exit /b 1

ssh -t -p %VPS_PORT% %VPS_USER%@%VPS_HOST% "command -v %GLOBAL_ALIAS% >/dev/null 2>&1 || { echo '[ERROR] %GLOBAL_ALIAS% not installed. Run start.bat install first.'; exit 1; }; %GLOBAL_ALIAS% %*" || exit /b 1
exit /b 0

:write_dispatcher
set "DISPATCHER_FILE=%~1"
> "%DISPATCHER_FILE%" echo #!/usr/bin/env bash
>> "%DISPATCHER_FILE%" echo set -euo pipefail
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo SERVICE_NAME='%SERVICE_NAME%'
>> "%DISPATCHER_FILE%" echo SERVICE_USER='%SERVICE_USER%'
>> "%DISPATCHER_FILE%" echo SERVICE_PORT='%SERVICE_PORT%'
>> "%DISPATCHER_FILE%" echo REMOTE_DIR='%REMOTE_DIR%'
>> "%DISPATCHER_FILE%" echo REMOTE_HOME='%REMOTE_HOME%'
>> "%DISPATCHER_FILE%" echo DISPATCHER_NAME='%DISPATCHER_NAME%'
>> "%DISPATCHER_FILE%" echo GLOBAL_ALIAS='%GLOBAL_ALIAS%'
>> "%DISPATCHER_FILE%" echo CORE_BINARY_NAME='%CORE_BINARY_NAME%'
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo SCRIPT_PATH="${REMOTE_DIR}/${DISPATCHER_NAME}"
>> "%DISPATCHER_FILE%" echo CORE_BIN="${REMOTE_DIR}/bin/${CORE_BINARY_NAME}"
>> "%DISPATCHER_FILE%" echo SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo run_core^(^) {
>> "%DISPATCHER_FILE%" echo   "${CORE_BIN}" --api-home "${REMOTE_HOME}" "$@"
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo install_service^(^) {
>> "%DISPATCHER_FILE%" echo   if ^! command -v systemctl ^>/dev/null 2^>^&1; then
>> "%DISPATCHER_FILE%" echo     echo "[ERROR] systemd not found on this host." ^>^&2
>> "%DISPATCHER_FILE%" echo     exit 1
>> "%DISPATCHER_FILE%" echo   fi
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo   if [[ ^! -x "${CORE_BIN}" ]]; then
>> "%DISPATCHER_FILE%" echo     echo "[ERROR] core binary not found: ${CORE_BIN}" ^>^&2
>> "%DISPATCHER_FILE%" echo     exit 1
>> "%DISPATCHER_FILE%" echo   fi
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo   sudo install -d -m 755 "${REMOTE_DIR}" "${REMOTE_DIR}/bin" "${REMOTE_HOME}"
>> "%DISPATCHER_FILE%" echo   sudo ln -sf "${SCRIPT_PATH}" /usr/local/bin/copilot-api
>> "%DISPATCHER_FILE%" echo   sudo ln -sf "${SCRIPT_PATH}" /usr/local/bin/${GLOBAL_ALIAS}
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo   sudo tee "${SERVICE_FILE}" ^>/dev/null ^<^<UNIT
>> "%DISPATCHER_FILE%" echo [Unit]
>> "%DISPATCHER_FILE%" echo Description=GitHub Copilot API Service
>> "%DISPATCHER_FILE%" echo After=network-online.target
>> "%DISPATCHER_FILE%" echo Wants=network-online.target
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo [Service]
>> "%DISPATCHER_FILE%" echo Type=simple
>> "%DISPATCHER_FILE%" echo User=${SERVICE_USER}
>> "%DISPATCHER_FILE%" echo WorkingDirectory=${REMOTE_DIR}
>> "%DISPATCHER_FILE%" echo ExecStart=${CORE_BIN} --api-home ${REMOTE_HOME} start --port ${SERVICE_PORT}
>> "%DISPATCHER_FILE%" echo Restart=always
>> "%DISPATCHER_FILE%" echo RestartSec=3
>> "%DISPATCHER_FILE%" echo Environment=COPILOT_API_HOME=${REMOTE_HOME}
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo [Install]
>> "%DISPATCHER_FILE%" echo WantedBy=multi-user.target
>> "%DISPATCHER_FILE%" echo UNIT
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo   sudo systemctl daemon-reload
>> "%DISPATCHER_FILE%" echo   sudo systemctl enable --now "${SERVICE_NAME}"
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo   echo "[OK] service installed: ${SERVICE_NAME}"
>> "%DISPATCHER_FILE%" echo   echo "[OK] command aliases: copilot-api, ${GLOBAL_ALIAS}"
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo service_cmd^(^) {
>> "%DISPATCHER_FILE%" echo   local cmd="$1"
>> "%DISPATCHER_FILE%" echo   sudo systemctl "${cmd}" "${SERVICE_NAME}"
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo show_logs^(^) {
>> "%DISPATCHER_FILE%" echo   local lines="${1:-200}"
>> "%DISPATCHER_FILE%" echo   sudo journalctl -u "${SERVICE_NAME}" -n "${lines}" --no-pager
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo uninstall_service^(^) {
>> "%DISPATCHER_FILE%" echo   sudo systemctl disable --now "${SERVICE_NAME}" ^|^| true
>> "%DISPATCHER_FILE%" echo   sudo rm -f "${SERVICE_FILE}"
>> "%DISPATCHER_FILE%" echo   sudo systemctl daemon-reload
>> "%DISPATCHER_FILE%" echo   sudo rm -f /usr/local/bin/copilot-api /usr/local/bin/${GLOBAL_ALIAS}
>> "%DISPATCHER_FILE%" echo   echo "[OK] service removed: ${SERVICE_NAME}"
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo api_query^(^) {
>> "%DISPATCHER_FILE%" echo   local target="${1:-accounts}"
>> "%DISPATCHER_FILE%" echo   case "${target}" in
>> "%DISPATCHER_FILE%" echo     accounts^) curl -fsS "http://127.0.0.1:${SERVICE_PORT}/accounts" ;;
>> "%DISPATCHER_FILE%" echo     status^|accounts-status^) curl -fsS "http://127.0.0.1:${SERVICE_PORT}/accounts/status" ;;
>> "%DISPATCHER_FILE%" echo     *^) echo "[ERROR] Unknown api target: ${target}" ^>^&2; exit 1 ;;
>> "%DISPATCHER_FILE%" echo   esac
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo usage^(^) {
>> "%DISPATCHER_FILE%" echo   cat ^<^<USAGE
>> "%DISPATCHER_FILE%" echo copilot-api dispatcher
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo Commands:
>> "%DISPATCHER_FILE%" echo   install                     Install/refresh systemd service and global aliases
>> "%DISPATCHER_FILE%" echo   start^|stop^|restart^|status   Manage service
>> "%DISPATCHER_FILE%" echo   logs [N]                    Show last N logs (default 200)
>> "%DISPATCHER_FILE%" echo   accounts                    Run: account list
>> "%DISPATCHER_FILE%" echo   accounts-status             Run: account status
>> "%DISPATCHER_FILE%" echo   account ...                 Passthrough to account command
>> "%DISPATCHER_FILE%" echo   api [accounts^|status]       Query HTTP endpoints
>> "%DISPATCHER_FILE%" echo   uninstall                   Remove service and aliases
>> "%DISPATCHER_FILE%" echo   help
>> "%DISPATCHER_FILE%" echo USAGE
>> "%DISPATCHER_FILE%" echo }
>> "%DISPATCHER_FILE%" echo.
>> "%DISPATCHER_FILE%" echo cmd="${1:-help}"
>> "%DISPATCHER_FILE%" echo case "${cmd}" in
>> "%DISPATCHER_FILE%" echo   install^) install_service ;;
>> "%DISPATCHER_FILE%" echo   start^|stop^|restart^|status^) service_cmd "${cmd}" ;;
>> "%DISPATCHER_FILE%" echo   logs^) show_logs "${2:-200}" ;;
>> "%DISPATCHER_FILE%" echo   accounts^) run_core account list ;;
>> "%DISPATCHER_FILE%" echo   accounts-status^) run_core account status ;;
>> "%DISPATCHER_FILE%" echo   account^) shift; run_core account "$@" ;;
>> "%DISPATCHER_FILE%" echo   api^) shift; api_query "${1:-accounts}" ;;
>> "%DISPATCHER_FILE%" echo   uninstall^) uninstall_service ;;
>> "%DISPATCHER_FILE%" echo   help^|-h^|--help^) usage ;;
>> "%DISPATCHER_FILE%" echo   *^)
>> "%DISPATCHER_FILE%" echo     echo "[ERROR] Unknown command: ${cmd}" ^>^&2
>> "%DISPATCHER_FILE%" echo     usage
>> "%DISPATCHER_FILE%" echo     exit 1
>> "%DISPATCHER_FILE%" echo     ;;
>> "%DISPATCHER_FILE%" echo esac
exit /b 0

:check_cmd
where %~1 >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Command not found: %~1
  exit /b 1
)
exit /b 0

:help
echo.
echo copilot-api deploy bootstrap ^(Windows -^> Debian^)
echo.
echo Before first install, set VPS_HOST:
echo   set VPS_HOST=1.2.3.4 ^&^& start.bat install
echo.
echo Local actions:
echo   start.bat install          - Build Linux binary, deploy dispatcher, install systemd service
echo   start.bat start            - Remote: capi start
echo   start.bat stop             - Remote: capi stop
echo   start.bat restart          - Remote: capi restart
echo   start.bat status           - Remote: capi status
echo   start.bat logs [N]         - Remote: capi logs [N]
echo   start.bat accounts         - Remote: capi accounts
echo   start.bat accounts-status  - Remote: capi accounts-status
echo   start.bat account list     - Remote: capi account list
echo   start.bat api accounts     - Remote: capi api accounts
echo   start.bat uninstall        - Remote: capi uninstall
echo.
echo Optional overrides:
echo   VPS_USER, VPS_PORT, SERVICE_NAME, SERVICE_USER, SERVICE_PORT, REMOTE_DIR, REMOTE_HOME
echo   DISPATCHER_NAME, GLOBAL_ALIAS, CORE_BINARY_NAME
echo.
exit /b 0
