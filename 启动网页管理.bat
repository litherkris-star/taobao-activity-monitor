@echo off
cd /d "%~dp0"
echo 正在启动网页管理后台...
echo 启动后在浏览器打开: http://127.0.0.1:3080
echo 关闭本窗口即停止网页管理（不影响监控程序）。
node admin-server.js
pause
