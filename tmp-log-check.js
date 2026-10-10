'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
const out = [];
// 找最近的 3 个"开始多店铺检测"起点，检查每轮的耗时行
let starts = [];
for (let i = log.length - 1; i >= 0 && starts.length < 3; i--) {
  if (log[i].includes('开始多店铺检测')) starts.unshift(i);
}
out.push('=== 最近 3 轮完整检查 ===');
for (let k = 0; k < starts.length; k++) {
  const from = starts[k];
  const to = k + 1 < starts.length ? starts[k + 1] : log.length;
  const round = log.slice(from, to);
  const hasCost = round.some((l) => l.includes('本轮检测耗时'));
  const hasDone = round.some((l) => l.includes('多店铺检测完成'));
  const first = round[0] ? round[0].slice(0, 80) : '';
  const last = round[round.length - 1] ? round[round.length - 1].slice(0, 120) : '';
  out.push(`[轮${k + 1}] 行数 ${round.length} | 起始 ${first}`);
  out.push(`        耗时行: ${hasCost ? '有' : '无'} | 完成行: ${hasDone ? '有' : '无'} | 结尾 ${last}`);
}
// 最近"服务已启动"与"本轮检测耗时"的位置
out.push('=== 最近关键行时间戳 ===');
for (const kw of ['服务已启动', '本轮检测耗时', '手动检测', '开始多店铺检测']) {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].includes(kw)) { out.push(kw + ' → ' + log[i].slice(0, 100)); break; }
  }
}
fs.writeFileSync(path.join(ROOT, 'tmp-log-check.txt'), out.join('\n'), 'utf8');
console.log('done');
