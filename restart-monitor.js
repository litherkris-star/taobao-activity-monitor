'use strict';
// 每日凌晨自动重启 monitor，释放 V8 堆内存；重启后延迟 45 分钟再跑第一轮，
// 避免在低峰期立即触发一轮登录检测（--delay=45 由 monitor.js daemon 支持）。
// 手动运行：node restart-monitor.js
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

function findMonitorPids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'monitor\\.js' -and $_.CommandLine -notmatch 'restart-monitor' } | ForEach-Object { $_.ProcessId }";
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 20000 }).trim();
    return out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function main() {
  const pids = findMonitorPids();
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
  }
  if (pids.length) {
    console.log(`已发送停止信号给 monitor 进程：${pids.join(', ')}`);
  } else {
    console.log('未找到运行中的 monitor 进程（可能守护脚本刚拉起或已被网页端停止）。');
  }
  // 等待优雅退出；monitor 若正在跑检测轮，SIGTERM 会等整轮结束（可能 10 分钟）。
  // 为避免新旧进程并发重复检测，等 6 秒后仍未退出则强杀（凌晨低峰期中断一轮影响极小）。
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const survivors = findMonitorPids();
  for (const pid of survivors) {
    try {
      execSync(`taskkill /F /PID ${Number(pid)}`, { timeout: 10000 });
      console.log(`monitor ${pid} 未在 6 秒内优雅退出，已强制停止。`);
    } catch (_) {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // 用 VBS 隐藏窗口启动（已验证隐藏有效；node spawn 的 windowsHide 在本机对 cmd /c 不生效，会弹出可见窗口）
  const vbsPath = path.join(ROOT, 'tmp-restart.vbs');
  const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    'WshShell.CurrentDirectory = "' + ROOT + '"',
    'WshShell.Run "cmd /c node monitor.js --delay=45 > monitor.log 2>&1", 0, False',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, 'ascii');
  try {
    spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' }).unref();
  } catch (error) {
    // wscript 失败时退回直接 spawn（可能出现可见窗口，但不影响功能）
    spawn('cmd.exe', ['/c', 'node monitor.js --delay=45 > monitor.log 2>&1'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  }
  // 等 VBS 把 monitor 拉起来后再清理临时 VBS
  setTimeout(() => {
    try { fs.unlinkSync(vbsPath); } catch (_) {}
  }, 8000);
  console.log('monitor 已重新启动（--delay=45，隐藏窗口，45 分钟后开始第一轮检测）。');
  process.exit(0);
}

main().catch((error) => {
  console.error('重启失败：' + (error.stack || error.message || String(error)));
  process.exit(1);
});
