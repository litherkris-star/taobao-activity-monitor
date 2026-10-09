'use strict';

// 一键为所有启用店铺各启动一个“监控专用 Chrome”窗口，并对配置了账号密码的店铺自动登录：
// - 每个店铺一个独立用户目录（chrome-profile-<店铺编号>），登录态、保存的账号密码互不影响；
// - 每个店铺一个独立调试端口（店铺配置 chromeDebugPort，缺省从全局 chromeDebugPort 起依次取空闲端口）；
// - 单店铺且存在旧版 chrome-profile 目录时自动沿用，无需重新登录；
// - 窗口启动后请保持打开，监控程序会按需连接各窗口检测商品。
//
// 端口分配算法必须与 monitor.js loadConfig 中的分配完全一致，否则监控会连错窗口。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Chrome profile 里的纯缓存目录（清掉不影响登录态：Cookies/Login Data/Local Storage 都不在列表里）。
// 这些目录只增不减，是多店铺部署磁盘占用的大头（每个店铺几百 MB 很常见）。
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

// 只能在 Chrome 实例关闭时调用（运行中的实例正在占用这些文件）。
function cleanProfileCache(profileDir) {
  let freed = 0;
  for (const rel of PROFILE_CACHE_DIRS) {
    const full = path.join(profileDir, rel);
    try {
      if (fs.existsSync(full)) {
        const size = dirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
        freed += size;
      }
    } catch (_) {}
  }
  return freed;
}

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

// 探测调试端口是否已有 Chrome 在运行（重复执行本脚本时跳过该店铺，避免在已开窗口里重复打开报名页标签）。
async function isPortBusy(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}

const ROOT = __dirname;
const CONFIG_PATH = process.env.TB_CONFIG || path.join(ROOT, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('未找到 config.json，请先运行 node configure.js 或网页管理添加店铺。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// 与 monitor.js 相同的端口分配：显式端口优先，未配置从 basePort 起取空闲端口。
function assignPorts(config, shops) {
  const basePort = Math.max(1024, Math.min(65535, Number(config.chromeDebugPort) || 9222));
  const usedPorts = new Set();
  for (const shop of shops) {
    let port = Number(shop.chromeDebugPort) || 0;
    if (!port || usedPorts.has(port)) {
      port = basePort;
      while (usedPorts.has(port)) port += 1;
    }
    usedPorts.add(port);
    shop.debugPort = port;
  }
}

async function main() {
  const config = loadConfig();
  let shops = (Array.isArray(config.shops) ? config.shops : []).filter((shop) => shop && shop.enabled !== false);
  // 可选参数：只启动指定店铺的窗口，如 node start-chrome.js cqh（某个店铺窗口被误关时单独重启用）。
  // 注意：端口分配必须先在“全部启用店铺”上做（顺序与 monitor.js 一致），再过滤要启动的店铺，
  // 否则单店铺启动时会被分到错误的调试端口。
  const onlyKeys = process.argv.slice(2).map((item) => String(item).trim()).filter(Boolean);
  const allEnabled = shops;
  if (onlyKeys.length) {
    shops = allEnabled.filter((shop) => onlyKeys.includes(String(shop.key || '')) || onlyKeys.includes(String(shop.name || '')));
    if (!shops.length) {
      console.error(`没有找到匹配的店铺：${onlyKeys.join('、')}（按店铺编号或店铺名匹配，可在网页管理查看编号）。`);
      process.exit(1);
    }
    console.log(`只启动指定店铺：${shops.map((s) => s.name || s.key).join('、')}\n`);
  }
  if (!shops.length) {
    console.error('config.json 中没有启用的店铺。');
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('未找到 Chrome 浏览器。请安装 Chrome，或设置环境变量 CHROME_PATH 指向 chrome.exe。');
    process.exit(1);
  }

  assignPorts(config, allEnabled || shops);
  console.log(`Chrome：${chrome}`);
  console.log(`共 ${shops.length} 个启用店铺，将各打开一个独立 Chrome 窗口（独立登录态、独立保存密码）。\n`);

  const launched = [];
  for (const shop of shops) {
    const key = String(shop.key || '').trim();
    // 用户目录：优先店铺配置 profileDir；单店铺时沿用旧版共享 chrome-profile；否则每店铺独立目录。
    let profileDir = String(shop.profileDir || '').trim();
    const legacyDir = path.join(ROOT, 'chrome-profile');
    if (!profileDir) {
      profileDir = (shops.length === 1 && fs.existsSync(legacyDir))
        ? legacyDir
        : path.join(ROOT, `chrome-profile-${key}`);
    }
    fs.mkdirSync(profileDir, { recursive: true });

    if (await isPortBusy(shop.debugPort)) {
      console.log(`【${shop.name || key}】调试端口 ${shop.debugPort} 已有 Chrome 在运行，跳过启动（避免重复打开标签页）。`);
      launched.push(shop);
      continue;
    }

    // 启动前清理该店铺的网页缓存（实例已确认没在运行，清理安全；登录态不受影响）。
    const freed = cleanProfileCache(profileDir);
    if (freed > 10 * 1024 * 1024) {
      console.log(`【${shop.name || key}】已清理网页缓存 ${(freed / 1024 / 1024).toFixed(0)} MB（登录态保留）。`);
    }

    const args = [
      `--remote-debugging-port=${shop.debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      // 限制磁盘缓存上限，防止缓存目录无限膨胀。
      '--disk-cache-size=104857600',
      '--media-cache-size=52428800',
      String(shop.activityUrl || config.activityUrl || 'https://myseller.taobao.com/home.htm'),
    ];
    try {
      const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
      child.unref();
      launched.push(shop);
      console.log(`已启动【${shop.name || key}】窗口：调试端口 ${shop.debugPort}，用户目录 ${profileDir}`);
    } catch (error) {
      console.error(`店铺 ${key} 的 Chrome 启动失败：${error.message || error}`);
    }
  }

  // 等 Chrome 窗口都起来后再逐个连接做自动登录。
  const needLogin = launched.filter((shop) => String(shop.account || '').trim() && String(shop.password || ''));
  const noCredential = launched.filter((shop) => !(String(shop.account || '').trim() && String(shop.password || '')));
  if (noCredential.length) {
    console.log(`\n以下店铺未配置账号密码，请在对应窗口手动登录一次：${noCredential.map((s) => s.name || s.key).join('、')}`);
  }
  if (!needLogin.length) {
    console.log('\n没有配置账号密码的店铺，跳过自动登录。');
    return;
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    console.log('\n未安装 playwright，无法自动登录。请在各窗口手动登录，或先运行 npm install。');
    return;
  }
  const { attemptPasswordLogin } = require('./password-login');

  console.log('\n等待浏览器窗口就绪（8 秒）…');
  await new Promise((resolve) => setTimeout(resolve, 8000));

  for (const shop of needLogin) {
    const label = shop.name || shop.key;
    console.log(`\n===== 【${label}】开始自动登录（端口 ${shop.debugPort}）=====`);
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${shop.debugPort}`);
    } catch (error) {
      console.log(`连接端口 ${shop.debugPort} 失败：${error.message || error}。请确认该窗口已打开，稍后可重试本脚本。`);
      continue;
    }
    try {
      const context = browser.contexts()[0] || await browser.newContext();
      // 复用窗口里已打开的标签页，让用户能看到自动登录过程。
      const pages = context.pages();
      const page = pages[0] || await context.newPage();
      const cliLog = async (level, message) => console.log(`  [${level}] ${message}`);
      const result = await attemptPasswordLogin(page, shop, cliLog, { challengeWaitSeconds: 180, manualAssist: true });
      if (result.ok) {
        console.log(`【${label}】登录成功，窗口保持打开即可。`);
      } else {
        console.log(`【${label}】自动登录未完成：${result.reason}`);
        console.log('  → 请在该窗口里手动完成登录（账号密码已填写的直接补验证即可）。');
      }
    } catch (error) {
      console.log(`【${label}】自动登录出错：${error.message || error}，请在该窗口手动登录。`);
    }
    // 注意：不要 browser.close()，那会关掉用户的 Chrome。直接断开即可。
  }

  console.log('\n全部店铺处理完毕。提示：');
  console.log('1. 监控期间请保持所有窗口打开，监控只借用标签页，不会关闭浏览器。');
  console.log('2. 登录时建议在 Chrome 提示“保存密码”时选择保存，并在登录页勾选“自动登录”。');
  console.log('3. 之后监控检测到掉线也会用配置的账号密码自动重登。');
}

main().catch((error) => { console.error(error); process.exit(1); });
