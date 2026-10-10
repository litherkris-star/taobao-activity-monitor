'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
const out = [];
// 最近一轮：找最后一个"开始多店铺检测"到"多店铺检测完成"
const starts = [];
log.forEach((l, i) => { if (l.includes('开始多店铺检测')) starts.push(i); });
const lastStart = starts[starts.length - 1];
out.push('最后检测开始: ' + log[lastStart].slice(0, 100));
const slice = log.slice(lastStart, lastStart + 400);
out.push('该段日志行数: ' + slice.length);
out.push('');
// 关键行
out.push('== 异常/报警/警告/完成/扫描相关 ==');
for (const l of slice) {
  if (/\[ALARM\]|\[ERROR\]|\[WARN\]|多店铺检测完成|异常名单|活动异常名单|页面标注|扫描第|翻页失败|未渲染|数量与页面标注不符/.test(l)) {
    out.push(l.slice(0, 240));
  }
}
out.push('');
// 每个店铺的商品结果统计
const shopStats = {};
for (const l of slice) {
  const m = l.match(/\[INFO\] \[(.+?)\] (\d+)：(.+)/);
  if (!m) continue;
  const shop = m[1];
  const status = m[3];
  if (!shopStats[shop]) shopStats[shop] = { total: 0, anomaly: 0 };
  shopStats[shop].total++;
  if (status.includes('异常')) shopStats[shop].anomaly++;
}
out.push('== 各店铺商品命中异常统计 ==');
for (const [s, v] of Object.entries(shopStats)) {
  out.push(`${s}: ${v.anomaly}/${v.total} 命中异常`);
}
fs.writeFileSync(path.join(ROOT, 'tmp-last.txt'), out.join('\n'), 'utf8');
console.log('done start=' + lastStart + ' lines=' + slice.length);
