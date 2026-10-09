@echo off
chcp 65001 >nul
title 停止淘宝活动监控服务

echo ========================================
echo   停止淘宝活动监控服务
echo ========================================
echo.

REM 只停止监控相关进程，不误杀其他 Node.js 应用（如 Kimi 等）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*monitor.js*' -or $_.CommandLine -like '*admin-server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('已停止 PID: ' + $_.ProcessId) }"

echo.
echo 已停止监控服务（管理后台 + 监控）
echo 不会影响其他 Node.js 应用
echo.
pause
