@echo off
chcp 65001 >nul
title 停止淘宝活动监控服务

echo ========================================
echo   停止淘宝活动监控服务
echo ========================================
echo.
echo   【重要提醒】停止后守护脚本会在 5 分钟内自动拉起服务！
echo   如需彻底停止，请先移走启动文件夹里的
echo   「淘宝活动监控-开机自启.vbs」，或停用「淘宝活动监控-守护」计划任务。
echo.
echo   如果只是想临时安静（不检测不报警、保留后台），
echo   请到管理后台点「暂停检测」，不要停止服务。
echo.
echo ========================================
echo.

REM 只停止监控相关进程，不误杀其他 Node.js 应用（如 Kimi 等）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*monitor.js*' -or $_.CommandLine -like '*admin-server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('已停止 PID: ' + $_.ProcessId) }"

echo.
echo 已停止监控服务（管理后台 + 监控）
echo 不会影响其他 Node.js 应用
echo.
pause
