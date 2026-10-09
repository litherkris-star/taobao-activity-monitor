'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = 'D:\\taobao-activity-monitor';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));

// 模板表头（与 admin-server.js HEADER_MAP 对应）
const headers = [
  '店铺编号*', '店铺名称*', '商品ID*', '商品标题', '活动名称', '活动页URL',
  '活动截止时间', '负责人', '监控开始时间', '监控模式', '下线活动关键词',
  '恢复成功关键词', '容差分钟', '活动价(元)', '库存下限(件)', '启用状态',
];

const rows = [headers];

let totalProducts = 0;
for (const shop of cfg.shops) {
  const products = shop.products || [];
  for (const p of products) {
    totalProducts += 1;
    rows.push([
      shop.key,
      shop.name,
      p.productId,
      p.productName || '',
      p.activityName || '',
      p.activityUrl || '',
      p.activityDeadline || '',
      p.owner || '',
      p.monitorSince || '',
      p.monitorMode === 'signup_date' ? '报名时间' : '添加时间',
      p.monitorActivityKeywords || '',
      p.recoveryActivityKeywords || '',
      p.recoveryGraceMinutes || 0,
      p.expectedPrice || 0,
      p.minStock || 0,
      p.enabled === false ? '停用' : '启用',
    ]);
  }
}

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '商品导入');

const outPath = path.join(ROOT, '超级立减店铺配置-2026-09-28.xlsx');
XLSX.writeFile(wb, outPath);

console.log('✅ 已生成导入文件:', outPath);
console.log('店铺数:', cfg.shops.length);
console.log('商品数:', totalProducts);
console.log('文件大小:', (fs.statSync(outPath).size / 1024).toFixed(1), 'KB');
