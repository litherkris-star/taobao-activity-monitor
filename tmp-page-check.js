'use strict';
const http = require('http');
http.get('http://127.0.0.1:3080/', (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => {
    const out = [
      'saveToast: ' + (body.includes('id="saveToast"') ? '存在' : '缺失!'),
      'productDetailModal: ' + (body.includes('id="productDetailModal"') ? '存在' : '缺失!'),
      '页面长度: ' + body.length + ' 字符',
      '包含 showToast 函数: ' + (body.includes('function showToast') || body.includes('showToast(') ? '是' : '否'),
    ];
    require('fs').writeFileSync('D:/taobao-activity-monitor/tmp-page-check.txt', out.join('\n'), 'utf8');
    console.log('done');
  });
}).on('error', (e) => {
  require('fs').writeFileSync('D:/taobao-activity-monitor/tmp-page-check.txt', '请求失败: ' + e.message, 'utf8');
  console.log('err');
});
