@echo off
chcp 936 >nul
title 一键清理缓存和日志
cd /d "%~dp0"
echo 请先关闭所有监控 Chrome 窗口，再按任意键继续...
pause
node cleanup-now.js
pause
