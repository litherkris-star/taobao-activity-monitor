@echo off
chcp 936 >nul
title 启动监控专用Chrome（所有店铺）
cd /d "%~dp0"
echo 正在为每个启用店铺各打开一个独立的监控专用 Chrome 窗口...
echo 每个窗口登录各自店铺（建议勾选“保存密码”），监控期间请保持窗口打开。
echo.
node "%~dp0start-chrome.js"
echo.
pause
