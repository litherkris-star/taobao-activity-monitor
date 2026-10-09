'use strict';
// 提取 admin.html 为独立前端目录 frontend/（index.html + assets/style.css + assets/app.js）
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/taobao-activity-monitor';
const src = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8').split('\n');
// 行号转下标（文件 1-based → 数组 0-based）
const L = (n) => src[n - 1];

// 验证边界标记，防止版本变化导致切分错位
const checks = [
  [7, '<style>'], [180, '</style>'], [181, '</head>'], [182, '<body>'],
  [366, '<script src="vendor/echarts.min.js"></script>'], [367, '<script>'],
  [1293, '</script>'], [1322, '</body>'], [1323, '</html>'],
];
for (const [n, expect] of checks) {
  const got = L(n).trim();
  if (!got.startsWith(expect)) {
    console.error(`边界校验失败 行${n}: 期望 "${expect}" 实际 "${got}"`);
    process.exit(1);
  }
}

const css = src.slice(7, 179).join('\n');        // 行 8..179
const bodyHtml = src.slice(182, 365).join('\n'); // 行 183..365
const appJs = src.slice(367, 1292).join('\n');   // 行 368..1292

const indexHtml = [
  L(1), L(2), L(3), L(4), L(5), L(6),
  '<link rel="stylesheet" href="assets/style.css">',
  '</head>',
  '<body>',
  bodyHtml,
  '<script src="assets/echarts.min.js"></script>',
  '<script src="assets/app.js"></script>',
  '</body>',
  '</html>',
  '',
].join('\n');

const frontend = path.join(ROOT, 'frontend');
const assets = path.join(frontend, 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(frontend, 'index.html'), indexHtml, 'utf8');
fs.writeFileSync(path.join(assets, 'style.css'), css, 'utf8');
fs.writeFileSync(path.join(assets, 'app.js'), appJs, 'utf8');
fs.copyFileSync(path.join(ROOT, 'vendor', 'echarts.min.js'), path.join(assets, 'echarts.min.js'));
console.log('提取完成:');
console.log('  frontend/index.html      ' + fs.statSync(path.join(frontend, 'index.html')).size + ' B');
console.log('  frontend/assets/style.css ' + fs.statSync(path.join(assets, 'style.css')).size + ' B');
console.log('  frontend/assets/app.js    ' + fs.statSync(path.join(assets, 'app.js')).size + ' B');
console.log('  frontend/assets/echarts.min.js 复制完成');
