'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = 'D:/taobao-activity-monitor';
const out = [];
try {
  const ps = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8', timeout: 30000 });
  const arr = JSON.parse(ps);
  const list = Array.isArray(arr) ? arr : [arr];
  for (const p of list) {
    if (p.CommandLine && /monitor/.test(p.CommandLine)) out.push('PID=' + p.ProcessId + ' | ' + String(p.CommandLine).slice(0, 90));
  }
} catch (e) { out.push('进程查询失败'); }
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
let start = -1;
for (let i = log.length - 1; i >= 0; i--) {
  if (log[i].includes('开始多店铺检测')) { start = i; break; }
}
const round = start >= 0 ? log.slice(start) : [];
out.push('=== 最新一轮关键行（共 ' + round.length + ' 行，首行时间 ' + (round[0] || '').slice(1, 20) + '） ===');
for (const l of round) {
  const short = l.replace(/^\[\d{4}-\d{2}-\d{2} /, '').slice(0, 150);
  if (/开始检测|自动登录成功|进入活动页|扫描无效|WARN|ERROR|多店铺检测完成|本轮检测耗时|ALARM/.test(l)) out.push(short);
  if (out.length > 50) break;
}
out.push('=== 文件最后一行 ===');
out.push((log[log.length - 1] || '').slice(0, 150));
fs.writeFileSync(path.join(ROOT, 'tmp-round.txt'), out.join('\n'), 'utf8');
console.log('done');
