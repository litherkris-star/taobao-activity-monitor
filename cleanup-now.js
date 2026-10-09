'use strict';

// 一键清理磁盘占用：
//   1. 删除 logs/ 里 48 小时前的日志和错误截图，monitor.log 超过 20MB 的部分轮转为 monitor.old.log；
//   2. 清理所有店铺 Chrome 用户目录里的网页缓存（Cache/Code Cache/GPUCache/Service Worker 缓存等）。
//
// 注意：清理缓存前请先关闭所有监控 Chrome 窗口（运行中的实例正占用缓存文件，清不干净）。
// 登录态（Cookies/Login Data/Local Storage）不在清理范围内，清完不需要重新登录。

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 20 * 1024 * 1024;

const PROFILE_CACHE_DIRS = [
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  path.join('Default', 'Cache'),
  path.join('Default', 'Code Cache'),
  path.join('Default', 'Media Cache'),
  path.join('Default', 'Service Worker', 'CacheStorage'),
  path.join('Default', 'Service Worker', 'ScriptCache'),
];

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += dirSize(full);
        else total += fs.statSync(full).size;
      } catch (_) {}
    }
  } catch (_) {}
  return total;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

let freedTotal = 0;

// 1. 日志：删除 48 小时前的文件；monitor.log 超 20MB 轮转。
try {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  let removed = 0;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (name === 'monitor.log' || name === 'monitor.old.log') continue;
    const full = path.join(LOG_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        freedTotal += stat.size;
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (_) {}
  }
  console.log(`日志清理：删除 ${removed} 个 48 小时前的日志/截图文件。`);
  const mainLog = path.join(LOG_DIR, 'monitor.log');
  try {
    const stat = fs.statSync(mainLog);
    if (stat.size > LOG_MAX_BYTES) {
      const oldLog = path.join(LOG_DIR, 'monitor.old.log');
      try { freedTotal += fs.statSync(oldLog).size; fs.unlinkSync(oldLog); } catch (_) {}
      fs.renameSync(mainLog, oldLog);
      console.log(`monitor.log 已超 20MB，已轮转为 monitor.old.log（仅保留最近一份）。`);
    }
  } catch (_) {}
} catch (_) {
  console.log('日志目录不存在，跳过日志清理。');
}

// 2. 各店铺 Chrome 用户目录的网页缓存。
const profileDirs = [];
for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name);
  try {
    if (!fs.statSync(full).isDirectory()) continue;
  } catch (_) { continue; }
  if (name === 'chrome-profile' || name.startsWith('chrome-profile-')) profileDirs.push(full);
}
// 内置浏览器模式的 profiles/<店铺编号> 目录。
const builtinRoot = path.join(ROOT, 'profiles');
if (fs.existsSync(builtinRoot)) {
  for (const name of fs.readdirSync(builtinRoot)) {
    const full = path.join(builtinRoot, name);
    try {
      if (fs.statSync(full).isDirectory()) profileDirs.push(full);
    } catch (_) {}
  }
}

if (!profileDirs.length) {
  console.log('没有找到任何店铺 Chrome 用户目录。');
}
for (const dir of profileDirs) {
  let freed = 0;
  for (const rel of PROFILE_CACHE_DIRS) {
    const full = path.join(dir, rel);
    try {
      if (fs.existsSync(full)) {
        const size = dirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
        freed += size;
      }
    } catch (_) {}
  }
  freedTotal += freed;
  console.log(`${path.basename(dir)}：清理缓存 ${mb(freed)} MB`);
}

console.log('');
console.log(`清理完成，共释放约 ${mb(freedTotal)} MB。登录态未受影响，无需重新登录。`);
