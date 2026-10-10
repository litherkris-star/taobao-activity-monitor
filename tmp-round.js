'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
const out = [];
// 找最近一轮起点
let lastStart = -1;
for (let i = log.length - 1; i >= 0; i--) {
  if (log[i].includes('开始多店铺检测')) { lastStart = i; break; }
}
const round = lastStart >= 0 ? log.slice(lastStart) : log.slice(-200);
out.push('=== 最近一轮（' + round.length + ' 行） ===');
// 只输出关键行：店铺开始/登录/活动页/异常/警告/错误/完成
const KEY = /开始检测|自动登录|登录成功|进入活动页|扫描无效|ERROR|WARN|ALARM|未在异常名单|命中|多店铺检测完成|本轮检测耗时|开始多店铺检测/;
for (const l of round) {
  if (KEY.test(l)) out.push(l.slice(0, 200));
}
fs.writeFileSync(path.join(ROOT, 'tmp-round.txt'), out.join('\n'), 'utf8');
console.log('done');
