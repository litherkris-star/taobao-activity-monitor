'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const log = fs.readFileSync(path.join(ROOT, 'logs', 'monitor.log'), 'utf8').split('\n').filter(Boolean);
const out = [];
let lastStart = -1;
for (let i = log.length - 1; i >= 0; i--) {
  if (log[i].includes('开始多店铺检测')) { lastStart = i; break; }
}
const round = lastStart >= 0 ? log.slice(lastStart) : log.slice(-300);
const shops = [];
let cur = null;
const ts = (l) => { const m = l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/); return m ? new Date(m[1]).getTime() : null; };
for (const l of round) {
  const shopM = l.match(/\[([\u4e00-\u9fa5A-Za-z]+?旗舰店)\]/);
  if (shopM) {
    if (cur && cur.name !== shopM[1]) { shops.push(cur); cur = null; }
    if (!cur) cur = { name: shopM[1], start: ts(l), login: null, filled: null, submitted: null, ok: null, detect: null };
  }
  if (!cur) continue;
  if (!cur.login && l.includes('正在用账号密码登录')) cur.login = ts(l);
  if (!cur.filled && l.includes('账号密码已自动填写并通过写入校验')) cur.filled = ts(l);
  if (!cur.submitted && l.includes('已提交登录表单')) cur.submitted = ts(l);
  if (!cur.ok && l.includes('密码登录成功')) cur.ok = ts(l);
  if (!cur.detect && l.includes('自动登录成功，开始检测')) cur.detect = ts(l);
}
if (cur) shops.push(cur);
const diff = (a, b) => (a != null && b != null) ? ((b - a) / 1000).toFixed(1) + 's' : '—';
out.push('=== 最近一轮各店铺登录耗时 ===');
out.push('店铺 | 跳登录页 | 切标签+填写 | 提交等待 | 登录成功 | 成功→开始检测 | 登录总耗时');
for (const s of shops) {
  out.push(`${s.name} | ${diff(s.start, s.login)} | ${diff(s.login, s.filled)} | ${diff(s.filled, s.submitted)} | ${diff(s.submitted, s.ok)} | ${diff(s.ok, s.detect)} | ${diff(s.start, s.detect)}`);
}
// 汇总统计
let total = 0, n = 0;
for (const s of shops) {
  const t = (s.start != null && s.detect != null) ? (s.detect - s.start) / 1000 : null;
  if (t != null) { total += t; n++; }
}
if (n) out.push(`平均每店登录耗时: ${(total / n).toFixed(1)}s（9店合计约 ${(total / 60).toFixed(1)} 分钟）`);
fs.writeFileSync(path.join(ROOT, 'tmp-login-time.txt'), out.join('\n'), 'utf8');
console.log('done');
