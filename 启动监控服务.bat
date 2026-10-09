@echo off
chcp 65001 >nul
title 淘宝活动监控服务

cd /d "%~dp0"

echo ========================================
echo   淘宝/天猫多店铺活动异常监控
echo   服务启动中...
echo ========================================

REM 启动管理后台（最小化窗口）
start "管理后台" /min cmd /k "node admin-server.js"
timeout /t 2 /nobreak >nul

REM 启动监控服务（最小化窗口）
start "监控服务" /min cmd /k "node monitor.js"

echo.
echo ========================================
echo   服务已启动！
echo   管理后台: http://127.0.0.1:3080
echo   窗口已最小化到任务栏
echo ========================================
echo.
echo 此窗口可关闭，服务在后台继续运行。
timeout /t 5
exit
