@echo off
chcp 65001 >nul
title 提交代码到版本库
cd /d "%~dp0"
echo ========================================
echo   正在提交所有改动到版本库...
echo ========================================
"C:\Program Files\Git\cmd\git.exe" add -A
"C:\Program Files\Git\cmd\git.exe" commit -m "auto commit %date% %time%" --quiet
echo.
echo   已完成（如无改动则会显示无需提交）。
echo   查看历史：git log --oneline
echo.
pause
