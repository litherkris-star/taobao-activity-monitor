'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
const out = [];
out.push('=== 10-10 最新轮关键行（从 14:20:27 起） ===');
let start = -1;
for (let i = log.length - 1; i >= 0; i--) {
  if (log[i].includes('2026-10-10 14:20:27') && log[i].includes('开始多店铺检测')) { start = i; break; }
}
const round = start >= 0 ? log.slice(start) : [];
for (const l of round) {
  const short = l.replace(/^\[\d{4}-\d{2}-\d{2} /, '').slice(0, 150);
  if (/开始检测|自动登录成功|进入活动页|扫描无效|WARN|ERROR|多店铺检测完成|本轮检测耗时|ALARM/.test(l)) out.push(short);
  if (out.length > 60) break;
}
const last = log[log.length - 1];
out.push('=== 文件最后一行 ===');
out.push(last.slice(0, 150));
fs.writeFileSync(path.join(ROOT, 'tmp-round.txt'), out.join('\n'), 'utf8');
console.log('done');
