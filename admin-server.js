'use strict';

// 轻量网页管理后台：浏览器里维护店铺与商品白名单、触发一次检测、查看最近结果。
// 默认仅监听本机 127.0.0.1；要分享给同事（局域网）时，在 config.json 设置 "adminHost": "0.0.0.0"，
// 建议同时设置 "adminToken": "一串口令"（不设则同网络的人都能改配置）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = process.env.TB_CONFIG || path.join(ROOT, 'config.json');
const RESULTS_PATH = path.join(ROOT, 'data', 'last-results.json');
// 与 monitor.js 约定：该文件存在 = 自动检测已暂停。
const PAUSE_FLAG_PATH = path.join(ROOT, 'data', 'monitor-paused.flag');
const LOG_PATH = path.join(ROOT, 'logs', 'monitor.log');
const OP_LOG_PATH = path.join(ROOT, 'data', 'operation.log');
const ADMIN_HTML = path.join(ROOT, 'frontend', 'index.html');
const PORT = Math.max(1024, Math.min(65535, Number(process.env.ADMIN_PORT || 3080)));

// 启动时读一次 config.json 取 adminHost/adminToken（环境变量优先；修改后需重启本服务生效）。
let startupAdminConfig = {};
try {
  startupAdminConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
} catch (_) { /* 首次运行没有 config.json 也能起服务 */ }
const HOST = process.env.ADMIN_HOST || String(startupAdminConfig.adminHost || '').trim() || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || String(startupAdminConfig.adminToken || '').trim();
let runOnceBusy = false;
let runOnceChild = null;
let runOnceCancelled = false;

// 超级立减活动网址预设表：一键恢复时按店铺编号写回 activityUrl
const SUPER_DEAL_URLS = {
  KS: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3112212368&puCode=itemApply&processId=8284eb55a360427281747be385722038',
  SNDR: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3089404002',
  YG: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3077419240',
  JYYX: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3127397459',
  LPZY: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3187787382',
  CT: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3110999109&puCode=itemApply&processId=2621263e158a4694b91b87a4cf603401',
  JJG: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3082447612&puCode=itemApply&processId=50e53cc864524cd7984c7e82af5b94e3',
  SFJ: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3123633444&puCode=itemApply&processId=ced9abd456c34185bd335c519de1d594',
  QJG: 'https://qn.taobao.com/home.htm/starb/tmc-next/sale/seller/apply.htm?signRecordId=3408930174&puCode=itemApply&processId=307d096cbc89449582b16d69129ab363',
};

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
}

// ===== 自动任务计划（每日简报 / 定时重启）=====
// 网页「报警设置」里的开关和时间，会同步到 Windows 计划任务（启用=创建/更新到点时间，禁用=停用）。
// 如 node 安装路径不同，可在 config.json 加 "nodePath" 覆盖。
// config.json 缺失/损坏时也要能起服务（下方 try/catch 保护，与「首次运行无配置也能起服务」的注释一致）。
let startupNodePath = '';
try { startupNodePath = String(readConfig().nodePath || ''); } catch (_) {}
const SYSTEM_NODE = process.env.TB_NODE_PATH || startupNodePath || 'D:\\nodejs\\node-v24.21.0-win-x64\\node.exe';
const SCHEDULE_TASKS = {
  dailyReport: { name: '淘宝活动监控-日报', script: 'daily-report.js', defaultTime: '21:00', key: 'dailyReportEnabled', timeKey: 'dailyReportTime' },
  autoRestart: { name: '淘宝活动监控-重启', script: 'restart-monitor.js', defaultTime: '04:00', key: 'autoRestartEnabled', timeKey: 'autoRestartTime' },
};

function taskExists(taskName) {
  return new Promise((resolve) => {
    const child = spawn('schtasks', ['/query', '/tn', taskName], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

function runSchTasks(args) {
  return new Promise((resolve) => {
    const child = spawn('schtasks', args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, output: out.trim() }));
  });
}

// 依据 config 里的日报/重启开关与时间，同步 Windows 计划任务。
// keys 为空 = 同步全部；传 keys（如 ['dailyReport']）时只同步指定任务，互不影响。
// 注意：本机 schtasks /change 会挂起（计划任务服务交互问题），统一用「删除重建」实现开关与改时。
async function applyScheduleTasks(config, keys) {
  const defs = (keys && keys.length)
    ? Object.entries(SCHEDULE_TASKS).filter(([key]) => keys.includes(key)).map(([, value]) => value)
    : Object.values(SCHEDULE_TASKS);
  const results = [];
  for (const def of defs) {
    const enabled = config[def.key] !== false;
    const time = String(config[def.timeKey] || '').trim() || def.defaultTime;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
      results.push(`${def.name}：时间格式不对（${time}），未修改`);
      continue;
    }
    const exists = await taskExists(def.name);
    if (!enabled) {
      if (exists) {
        const r = await runSchTasks(['/delete', '/tn', def.name, '/f']);
        results.push(`${def.name}：${r.ok ? '已停用（任务已删除）' : '停用失败 ' + r.output}`);
      } else {
        results.push(`${def.name}：已停用（任务不存在）`);
      }
    } else {
      const cmd = `"${SYSTEM_NODE}" "${path.join(ROOT, def.script)}"`;
      if (exists) {
        await runSchTasks(['/delete', '/tn', def.name, '/f']);
      }
      const r = await runSchTasks(['/create', '/tn', def.name, '/tr', cmd, '/sc', 'daily', '/st', time, '/f']);
      results.push(`${def.name}：${r.ok ? '已启用（每天 ' + time + '）' : '创建失败 ' + r.output}`);
    }
  }
  return results;
}

function backupPath() {
  return `${CONFIG_PATH}.backup-${Date.now()}`;
}

// 自动备份轮转：只保留最近 MAX_BACKUPS 个 backup 文件，防止磁盘上堆积几百个旧配置备份。
const MAX_BACKUPS = 50;
function writeConfig(config) {
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, backupPath());
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    const dir = path.dirname(CONFIG_PATH);
    const prefix = path.basename(CONFIG_PATH) + '.backup-';
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    const excess = Math.max(0, backups.length - MAX_BACKUPS);
    for (const name of backups.slice(0, excess)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
    }
  } catch (_) {}
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // 允许本地启动器.html（file:// 打开）跨源调用 /api/*；真实鉴权由 adminToken 承担。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Admin-Token, Content-Type',
  });
  res.end(body);
}

// 管理口令校验：config.json 设置了 adminToken 时，所有 /api/* 请求必须带 X-Admin-Token 头。
// 前端发送前会做 encodeURIComponent（HTTP 头不允许中文），这里解码后比对；兼容未编码的旧值。
function checkToken(req) {
  if (!ADMIN_TOKEN) return true;
  const raw = String(req.headers['x-admin-token'] || '');
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) { /* 保留原值 */ }
  return raw === ADMIN_TOKEN || decoded === ADMIN_TOKEN;
}

// 配置文件版本戳：用于多人同时编辑时的冲突检测（乐观锁）。
function configVersion() {
  try { return String(fs.statSync(CONFIG_PATH).mtimeMs); } catch (_) { return '0'; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 5 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 20 * 1024 * 1024) reject(new Error('文件过大'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 手机号归一化：去掉 +86/86 国家码前缀和所有非数字字符（空格、横杠），返回 5~15 位纯数字；不合法返回空串。
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
  return /^\d{5,15}$/.test(digits) ? digits : '';
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProduct(item) {
  const product = {
    productId: String(item.productId || '').trim(),
    // 商品名称保留原样（含首尾空格）：用户可能有意加空格排版，trim 会导致"改过却没保存生效"的困惑。
    productName: String(item.productName || ''),
    activityName: String(item.activityName || item.activity_name || '').trim(),
    activityUrl: String(item.activityUrl || item.activity_url || '').trim(),
    activityDeadline: String(item.activityDeadline || item.activity_deadline || '').trim(),
    owner: String(item.owner || '').trim(),
    monitorMode: String(item.monitorMode || 'added_time').trim() === 'signup_date' ? 'signup_date' : 'added_time',
    monitorSince: String(item.monitorSince || '').trim(),
    monitorActivityKeywords: String(item.monitorActivityKeywords || '').trim(),
    recoveryActivityKeywords: String(item.recoveryActivityKeywords || '').trim(),
    recoveryGraceMinutes: Math.max(0, Math.min(1440, numberOr(item.recoveryGraceMinutes, 0))),
    expectedPrice: Math.max(0, numberOr(item.expectedPrice, 0)),
    minStock: Math.max(0, Math.floor(numberOr(item.minStock, 0))),
    priceTolerance: Math.max(0, numberOr(item.priceTolerance, 0.01)),
    enabled: item.enabled !== false,
  };
  return product;
}

function validateAndNormalizeShops(input) {
  if (!Array.isArray(input)) throw new Error('shops 必须是数组');
  const keys = new Set();
  const shops = input.map((raw) => {
    const shop = raw && typeof raw === 'object' ? raw : {};
    const key = String(shop.key || '').trim();
    const name = String(shop.name || '').trim().replace(/^[【\[]+|[】\]]+$/g, '');
    if (!key) throw new Error('存在店铺编号为空的店铺');
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error(`店铺编号只能包含字母、数字、下划线：${key}`);
    if (keys.has(key)) throw new Error(`店铺编号重复：${key}`);
    keys.add(key);
    if (!name) throw new Error(`店铺 ${key} 缺少店铺名称`);
    const products = (Array.isArray(shop.products) ? shop.products : []).map(normalizeProduct);
    for (const product of products) {
      if (!product.productId) throw new Error(`店铺 ${key} 存在商品ID为空的商品`);
    }
    return {
      key,
      name,
      profileDir: String(shop.profileDir || '').trim(),
      activityUrl: String(shop.activityUrl || '').trim(),
      account: String(shop.account || '').trim(),
      password: String(shop.password || ''),
      chromeDebugPort: Math.max(0, Math.min(65535, Number(shop.chromeDebugPort) || 0)),
      enabled: shop.enabled !== false,
      verifyShopName: shop.verifyShopName !== false,
      products: products.map((product) => ({ ...product, shopName: name })),
    };
  });
  return shops;
}

// 只把页面返回的 shops 合并回 config.json，其他字段（钉钉密钥等）原样保留。
// 登录密码按密钥处理：页面留空提交时保留原密码，不会被清空。
function mergeConfig(config, shops) {
  const next = { ...config, shops };
  for (const shop of next.shops) {
    const old = (config.shops || []).find((item) => item.key === shop.key);
    if (old && !shop.profileDir) shop.profileDir = String(old.profileDir || '').trim();
    if (old && !shop.password) shop.password = String(old.password || '');
  }
  return next;
}

// 检测是否有常驻的自动巡检进程（node monitor.js，非 --once 手动实例）。
// 有的话，页面「立即检测/检测此店铺」另起的进程会与其并发抢 Chrome 端口、互相覆盖结果文件，需要在响应里提示用户。
function checkDaemonMonitor() {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'monitor\\.js' -and $_.CommandLine -notmatch '--once' } | Select-Object -ExpandProperty ProcessId"],
    { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const pids = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve(pids.length ? pids.join(',') : null);
    });
  });
}

function runOnce(shopKey) {
  return new Promise((resolve) => {
    if (runOnceBusy) {
      resolve({ ok: false, output: '上一次手动检测还在运行，请稍候。' });
      return;
    }
    runOnceBusy = true;
    runOnceCancelled = false;
    const resolveExtra = {};
    // 并发提示：常驻自动巡检若在运行（且未暂停），手动检测会与其并发，提前告知用户。
    checkDaemonMonitor().then((daemonPid) => {
      const concurrent = Boolean(daemonPid) && !fs.existsSync(PAUSE_FLAG_PATH);
      resolveExtra.concurrent = concurrent;
      resolveExtra.monitorHint = concurrent
        ? `自动巡检进程（PID ${daemonPid}）也在运行：本轮手动检测与其并发，Chrome 标签页与结果文件可能互相影响，完成后以最后写入的结果为准。`
        : '';
    }).catch(() => {});
    const args = [path.join(ROOT, 'monitor.js'), '--once'];
    if (shopKey) args.push(`--shop=${shopKey}`);
    const child = spawn(process.execPath, args, { cwd: ROOT });
    runOnceChild = child;
    let output = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, 10 * 60 * 1000);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      runOnceBusy = false;
      runOnceChild = null;
      if (runOnceCancelled) {
        resolve({ ok: false, cancelled: true, output: '手动检测已被取消。' });
        return;
      }
      resolve({ ok: code === 0, output: output.slice(-8000), ...resolveExtra });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      runOnceBusy = false;
      runOnceChild = null;
      resolve({ ok: false, output: String(error && error.message || error), ...resolveExtra });
    });
  });
}

// 取消正在运行的手动检测（误点「立即检测一次」时用；不影响自动巡检的暂停/恢复）。
function cancelRunOnce() {
  if (!runOnceBusy || !runOnceChild) return false;
  runOnceCancelled = true;
  try { runOnceChild.kill(); } catch (_) {}
  // Windows 上 kill 可能只结束 node 主进程，兜底再发一次强杀。
  try { runOnceChild.kill('SIGKILL'); } catch (_) {}
  return true;
}

function readResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readLogTail(limit) {
  try {
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    // 原始日志视图同样去掉行尾 JSON 调试尾巴（如 {"anomalies":"","error":""}），
    // 保留时间/级别/店铺/正文，让两个视图都干净易读；完整 JSON 仍在 logs\monitor.log 文件里可查。
    return text.split('\n').filter(Boolean).slice(-(limit || 80)).map((line) => {
      const brace = line.indexOf('{');
      if (brace < 0) return line;
      // 只截掉行尾以 { 开头的 JSON 尾巴（形如 正文 {"k":"v"}），避免误伤正文中的花括号。
      const tail = line.slice(brace);
      if (/^\s*\{[\s\S]*\}\s*$/.test(tail)) return line.slice(0, brace).trimEnd();
      return line;
    }).join('\n');
  } catch (_) {
    return '';
  }
}
// 从请求头读取花名（前端已 encodeURIComponent，这里解码还原中文）。
function getOperator(req) {
  try { return decodeURIComponent(String(req.headers['x-operator'] || '').trim()); } catch (_) { return ''; }
}
// 写入一条操作日志（保存/导入/恢复/启停等后台操作）；operator 为页面输入的花名（操作人），可空。
function logOperation(action, detail, operator) {
  try {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const op = String(operator || '').trim();
    const line = '[' + now + ']' + (op ? ' [' + op + ']' : '') + ' ' + action + (detail ? ' - ' + detail : '') + '\n';
    fs.mkdirSync(path.dirname(OP_LOG_PATH), { recursive: true });
    fs.appendFileSync(OP_LOG_PATH, line, 'utf8');
  } catch (_) {}
}

// 对比两份店铺配置，生成“具体操作”明细（新增/删除/修改 店铺与商品）
function diffShops(oldShops, newShops) {
  const parts = [];
  const oldMap = new Map(); const newMap = new Map();
  (oldShops || []).forEach((s) => oldMap.set(String(s.key || s.name || ''), s));
  (newShops || []).forEach((s) => newMap.set(String(s.key || s.name || ''), s));
  const limit = (arr) => (arr.length > 4 ? arr.slice(0, 4).join('、') + ' 等' + arr.length + '项' : arr.join('、'));
  const addedShops = [...newMap.keys()].filter((k) => !oldMap.has(k));
  const removedShops = [...oldMap.keys()].filter((k) => !newMap.has(k));
  if (addedShops.length) parts.push('新增店铺 ' + addedShops.join('、'));
  if (removedShops.length) parts.push('删除店铺 ' + removedShops.join('、'));
  for (const [key, ns] of newMap) {
    if (!oldMap.has(key)) continue;
    const os = oldMap.get(key);
    const oldIds = new Set((os.products || []).map((p) => String(p.productId || '').trim()).filter(Boolean));
    const newIds = new Set((ns.products || []).map((p) => String(p.productId || '').trim()).filter(Boolean));
    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));
    const oldById = new Map((os.products || []).map((p) => [String(p.productId || '').trim(), p]));
    // 比较商品的全部可编辑字段（productName/活动名/网址/有效期/负责人/监控条件/价格/库存/开关等），
    // 任何一项有变化都算"修改商品"。shopName 是店铺名派生字段，不参与比较。
    const changed = (ns.products || []).filter((p) => {
      const id = String(p.productId || '').trim();
      const op = oldById.get(id);
      if (!op) return false;
      const FIELDS = ['productName', 'activityName', 'activityUrl', 'activityDeadline', 'owner', 'monitorMode', 'monitorSince',
        'monitorActivityKeywords', 'recoveryActivityKeywords', 'recoveryGraceMinutes', 'expectedPrice', 'minStock',
        'priceTolerance', 'enabled', 'currentPrice', 'statusWord', 'url', 'title'];
      return FIELDS.some((f) => String(p[f] == null ? '' : p[f]) !== String(op[f] == null ? '' : op[f]));
    }).map((p) => String(p.productId || '').trim());
    const shopName = ns.name || key;
    if (added.length) parts.push(shopName + ' 新增商品 ' + limit(added));
    if (removed.length) parts.push(shopName + ' 删除商品 ' + limit(removed));
    if (changed.length) parts.push(shopName + ' 修改商品 ' + limit(changed));
  }
  return parts.join('；');
}

// 店铺自身字段（非商品）是否有实际变化；password/profileDir 页面留空 = 保留旧值，不算变化。
function shopFieldsChanged(oldShops, newShops) {
  const oldMap = new Map((oldShops || []).map((s) => [String(s.key || ''), s]));
  for (const ns of newShops || []) {
    const os = oldMap.get(String(ns.key || ''));
    if (!os) return true;
    for (const f of ['name', 'profileDir', 'activityUrl', 'account', 'password', 'chromeDebugPort', 'enabled', 'verifyShopName']) {
      if ((f === 'password' || f === 'profileDir') && (ns[f] == null || String(ns[f]).trim() === '')) continue;
      const a = os[f] == null ? '' : os[f];
      const b = ns[f] == null ? '' : ns[f];
      if (String(a) !== String(b)) return true;
    }
  }
  return false;
}

// 负责人→手机号映射比较（忽略键顺序）
function ownerPhonesEqual(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (String((a || {})[ka[i]]) !== String((b || {})[kb[i]])) return false;
  }
  return true;
}

// 读取最近 N 条操作日志（倒序：最新在前）；date 传 "YYYY-MM-DD" 或 "YYYY/M/D" 时只返回该日期的记录。
function readOperations(limit, date) {
  try {
    const text = fs.readFileSync(OP_LOG_PATH, 'utf8');
    let lines = text.split('\n').filter(Boolean);
    const d = String(date || '').trim();
    if (d) {
      // 日志时间格式为 zh-CN 的 [2026/10/8 16:21:35]（无前导零），把输入的 2026-10-08 归一化成 2026/10/8 再前缀匹配。
      const norm = d.replace(/-/g, '/').replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, (m, y, mo, da) => `${y}/${Number(mo)}/${Number(da)}`);
      lines = lines.filter((line) => line.startsWith(`[${norm}`));
    }
    return lines.slice(-(limit || 30)).reverse();
  } catch (_) {
    return [];
  }
}

// 解析监控日志为精简结构化行：时间 | 级别 | 店铺 | 摘要（去掉超长 JSON 尾巴）
function parseLogTail(rawText) {
  let lines = String(rawText || '').split('\n').filter(Boolean);
  // 定位倒数第 1、2 个「开始多店铺检测」行：
  // 若当前正好有一轮在进行（行数少），从「上一轮」起点开始取，保证至少展示一轮完整店铺日志。
  let idxLast = -1, idxPrev = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('开始多店铺检测')) {
      if (idxLast < 0) idxLast = i; else { idxPrev = i; break; }
    }
  }
  let startIdx = idxPrev >= 0 ? idxPrev : (idxLast >= 0 ? idxLast : -1);
  if (startIdx >= 0) {
    lines = lines.slice(startIdx);
    if (lines.length > 400) lines = lines.slice(-400); // 兜底上限，防止异常超大响应
  } else {
    lines = lines.slice(-60);
  }
  // 全局汇总行（不带店铺名）关键词：出现时打断店铺继承
  const GLOBAL_HINTS = ['开始多店铺检测', '多店铺检测完成', '下次检测将在', '已保存错误截图', '钉钉报警发送成功'];
  let lastShop = '';
  return lines.map((line) => {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(\w+)\](?: \[([^\]]+)\])? ?(.*)$/);
    if (!m) return { time: '', level: 'INFO', shop: '', text: line.slice(0, 160) };
    const level = String(m[2] || '').toUpperCase();
    let shop = m[3] || '';
    let text = m[4] || '';
    // 无店铺名的行：如果是全局汇总行则清空继承，否则继承最近店铺（登录流程等中间日志）
    if (!shop) {
      if (GLOBAL_HINTS.some((h) => text.includes(h))) {
        lastShop = '';
      } else {
        shop = lastShop;
      }
    } else {
      lastShop = shop;
    }
    const brace = text.indexOf('{');
    if (brace >= 0) text = text.slice(0, brace).trim();
    if (text.length > 110) text = text.slice(0, 110) + '…';
    return { time: m[1], level, shop, text };
  });
}


// ===== Excel 导入 =====

const HEADER_MAP = {
  店铺编号: 'shopKey',
  店铺名称: 'shopName',
  商品ID: 'productId',
  商品id: 'productId',
  商品标题: 'productName',
  商品名称: 'productName',
  活动名称: 'activityName',
  活动页URL: 'activityUrl',
  活动链接: 'activityUrl',
  活动报名页URL: 'activityUrl',
  活动截止时间: 'activityDeadline',
  活动结束时间: 'activityDeadline',
  截止时间: 'activityDeadline',
  负责人: 'owner',
  监控开始时间: 'monitorSince',
  监控模式: 'monitorMode',
  下线活动关键词: 'monitorActivityKeywords',
  恢复成功关键词: 'recoveryActivityKeywords',
  容差分钟: 'recoveryGraceMinutes',
  '活动价(元)': 'expectedPrice',
  活动价: 'expectedPrice',
  '库存下限(件)': 'minStock',
  库存下限: 'minStock',
  启用状态: 'enabledText',
};

function formatCellDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value || '').trim();
}

function parseImportWorkbook(buffer) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch (_) {
    throw new Error('缺少 xlsx 依赖，请先在程序目录运行一次 npm install');
  }
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames.find((name) => name.includes('导入')) || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  // 模板中必填列带 *（如“商品ID*”），识别表头和列映射时先剥掉星号；可不填列带“（可不填）”标注，同样剥掉。
  const headerName = (cell) => String(cell).trim().replace(/[＊*]+\s*$/, '').replace(/（可不填）$/, '');
  const headerIndex = rows.findIndex((row) => row.some((cell) => headerName(cell) === '商品ID'));
  if (headerIndex < 0) throw new Error('未找到表头行：第一行请使用模板中的列标题（店铺编号、店铺名称、商品ID……）');

  const columns = rows[headerIndex].map((cell) => HEADER_MAP[headerName(cell)] || '');
  const items = [];
  const errors = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const record = {};
    columns.forEach((field, c) => {
      if (field) record[field] = (field === 'monitorSince' || field === 'activityDeadline') ? formatCellDate(row[c]) : String(row[c] == null ? '' : row[c]).trim();
    });
    const lineNo = r + 1;
    if (!record.shopKey && !record.productId) continue; // 跳过空行
    if (!record.shopKey) { errors.push(`第 ${lineNo} 行：缺少店铺编号，已跳过`); continue; }
    if (!record.shopName) { errors.push(`第 ${lineNo} 行：缺少店铺名称，已跳过`); continue; }
    if (!/^\d+$/.test(record.productId)) { errors.push(`第 ${lineNo} 行：商品ID“${record.productId || '空'}”不是纯数字，已跳过（示例行请删除）`); continue; }
    record.monitorMode = /报名时间/.test(record.monitorMode) ? 'signup_date' : 'added_time';
    record.enabled = !/停用|禁用|暂停|否/.test(record.enabledText || '');
    record.recoveryGraceMinutes = Math.max(0, Math.min(1440, Number(record.recoveryGraceMinutes) || 0));
    record.expectedPrice = Math.max(0, Number(record.expectedPrice) || 0);
    record.minStock = Math.max(0, Math.floor(Number(record.minStock) || 0));
    delete record.enabledText;
    items.push(record);
  }
  if (!items.length) throw new Error(`没有可导入的商品。${errors.length ? errors.join('；') : '表格内容为空'}`);
  return { items, errors };
}

// 合并导入：同店铺编号复用店铺（不存在则新建），同商品ID更新、否则新增。
function applyImport(config, items) {
  if (!Array.isArray(config.shops)) config.shops = [];
  const summary = { shopsAdded: 0, productsAdded: 0, productsUpdated: 0 };
  for (const item of items) {
    let shop = config.shops.find((entry) => entry.key === item.shopKey);
    if (!shop) {
      shop = {
        key: item.shopKey, name: item.shopName, profileDir: '',
        activityUrl: String(item.activityUrl || '').trim(),
        enabled: true, verifyShopName: true, products: [],
      };
      config.shops.push(shop);
      summary.shopsAdded += 1;
    }
    if (!Array.isArray(shop.products)) shop.products = [];
    const product = {
      shopName: shop.name,
      productId: item.productId,
      productName: item.productName,
      activityName: item.activityName,
      activityUrl: item.activityUrl || '',
      activityDeadline: item.activityDeadline || '',
      owner: item.owner,
      monitorMode: item.monitorMode,
      monitorSince: item.monitorSince,
      monitorActivityKeywords: item.monitorActivityKeywords || '',
      recoveryActivityKeywords: item.recoveryActivityKeywords || '',
      recoveryGraceMinutes: item.recoveryGraceMinutes,
      expectedPrice: item.expectedPrice,
      minStock: item.minStock,
      priceTolerance: 0.01,
      enabled: item.enabled,
    };
    const existing = shop.products.find((entry) => String(entry.productId) === item.productId);
    if (existing) {
      Object.assign(existing, product);
      summary.productsUpdated += 1;
    } else {
      shop.products.push(product);
      summary.productsAdded += 1;
    }
  }
  return summary;
}

// ===== 外网入口拦截（花名验证）=====
// 局域网端口（默认 3080）不拦截；外网穿透指向 interceptPort（默认 3081），该端口所有请求先过花名校验，
// 输入正确花名（商品负责人花名，去重自动同步）后签发签名 cookie，之后 7 天内免输。
const INTERCEPT_COOKIE = 'intercept_token';

function getInterceptSecret() {
  const cfg = readConfig();
  if (!cfg.interceptSecret || cfg.interceptSecret.length < 32) {
    cfg.interceptSecret = require('crypto').randomBytes(24).toString('hex');
    writeConfig(cfg);
  }
  return cfg.interceptSecret;
}

function signInterceptToken(value, secret) {
  return require('crypto').createHmac('sha256', secret).update(String(value)).digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function interceptAuthorized(req) {
  const token = parseCookies(req)[INTERCEPT_COOKIE];
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const value = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const secret = getInterceptSecret();
  return signInterceptToken(value, secret) === sig && Number(value) > Date.now() - 7 * 24 * 3600 * 1000;
}

function ownerNameSet() {
  const cfg = readConfig();
  const set = new Set();
  for (const shop of cfg.shops || []) {
    for (const p of shop.products || []) {
      const o = String(p.owner || '').trim();
      if (o) set.add(o);
    }
  }
  return set;
}

function interceptPageHtml() {
  const names = [...ownerNameSet()];
  const hint = names.length ? names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : '') : '（尚未配置负责人花名，请联系管理员）';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请输入花名</title>
<style>html,body{margin:0;height:100%;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#1e3a5f 0%,#2b6cb0 100%);display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:40px 44px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center}
.logo{font-size:22px;font-weight:700;color:#1e3a5f;margin-bottom:6px}
.sub{color:#8a94a6;font-size:13px;margin-bottom:26px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d5dbe5;border-radius:10px;font-size:15px;outline:none;margin-bottom:12px;text-align:center}
input:focus{border-color:#2b6cb0;box-shadow:0 0 0 3px rgba(43,108,176,.15)}
button{width:100%;padding:12px;background:#2b6cb0;color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;font-weight:600}
button:hover{background:#245a96}
.err{color:#d64541;font-size:13px;margin-top:10px;min-height:18px}
.hint{color:#9aa5b5;font-size:12px;margin-top:14px}</style></head><body>
<div class="card">
  <div class="logo">活动监控 · 外网访问</div>
  <div class="sub">请输入你的花名后进入</div>
  <input id="name" placeholder="花名" autocomplete="off" autofocus>
  <button onclick="submit()">进入</button>
  <div class="err" id="err"></div>
  <div class="hint">可进入花名：${hint}</div>
</div>
<script>async function submit(){const n=document.getElementById('name').value.trim();const err=document.getElementById('err');if(!n){err.textContent='请输入花名';return;}
const r=await fetch('/api/intercept-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});
const j=await r.json().catch(()=>({}));
if(j.ok){location.reload();}else{err.textContent=j.error||'花名不正确';}}
document.getElementById('name').addEventListener('keydown',e=>{if(e.key==='Enter')submit();});</script>
</body></html>`;
}

const mainHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      // 禁用缓存，避免浏览器拿着旧版页面（看不到新功能按钮）。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(ADMIN_HTML));
      return;
    }
    // 静态资源：vendor/ 目录（目前只放 echarts.min.js）。仅允许 ROOT/vendor 内的文件，防路径穿越。
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const rel = decodeURIComponent(url.pathname.slice('/vendor/'.length)).replace(/\\/g, '/');
      const vendorRoot = path.join(ROOT, 'vendor');
      const filePath = path.normalize(path.join(vendorRoot, rel));
      if (!rel || rel.includes('..') || !filePath.startsWith(vendorRoot + path.sep) || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const ctype = ext === '.js' ? 'application/javascript; charset=utf-8' : (ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // 静态资源：assets/ 目录（提取后的前端目录 frontend/assets）。仅允许 ROOT/frontend/assets 内的文件，防路径穿越。
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const rel = decodeURIComponent(url.pathname.slice('/assets/'.length)).replace(/\\/g, '/');
      const assetsRoot = path.join(ROOT, 'frontend', 'assets');
      const filePath = path.normalize(path.join(assetsRoot, rel));
      if (!rel || rel.includes('..') || !filePath.startsWith(assetsRoot + path.sep) || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const ctype = ext === '.js' ? 'application/javascript; charset=utf-8' : (ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // CORS 预检（本地启动器 file:// 跨源 POST 前会先发 OPTIONS）。
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Admin-Token, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    // API 统一口令校验（未设置 adminToken 时直接放行）。
    if (url.pathname.startsWith('/api/') && !checkToken(req)) {
      sendJson(res, 401, { needToken: true, error: '需要管理口令' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const config = readConfig();
      // 登录密码不下发到页面，只告诉页面“是否已设置”，避免密码在网页里明文出现。
      const shops = (Array.isArray(config.shops) ? config.shops : []).map((shop) => ({
        ...shop,
        password: '',
        hasPassword: Boolean(String(shop.password || '')),
      }));
      sendJson(res, 200, {
        shops,
        intervalMinutes: numberOr(config.intervalMinutes, 30),
        anomalyRepeatMinutes: numberOr(config.anomalyRepeatMinutes, 30),
        browserMode: config.browserMode === 'cdp' ? 'cdp' : 'builtin',
        ownerPhones: config.ownerPhones && typeof config.ownerPhones === 'object' ? config.ownerPhones : {},
        dailyReportEnabled: config.dailyReportEnabled !== false,
        dailyReportTime: String(config.dailyReportTime || '').trim() || '21:00',
        dailyReportDingTalk: config.dailyReportDingTalk === true,
        quietHours: String(config.quietHours || '').trim(),
        autoRestartEnabled: config.autoRestartEnabled !== false,
        autoRestartTime: String(config.autoRestartTime || '').trim() || '04:00',
        updatedAt: configVersion(),
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}');
      // 乐观锁：页面基于旧版本保存时拒绝，防止多人同时编辑互相覆盖。
      if (body.baseUpdatedAt !== undefined && String(body.baseUpdatedAt) !== configVersion()) {
        sendJson(res, 409, { conflict: true, error: '配置刚被其他人修改过，请刷新页面获取最新内容后再保存。' });
        return;
      }
      const shops = validateAndNormalizeShops(body.shops);
      // 店铺内商品 ID 唯一校验：重复 ID 会干扰运行时去重与异常统计（检测条数对不上、误标红），保存时直接拦截。
      const dupReports = [];
      for (const shop of shops) {
        const seen = new Set();
        const dups = new Set();
        for (const product of shop.products) {
          const id = String(product.productId || '').trim();
          if (!id) continue;
          if (seen.has(id)) dups.add(id); else seen.add(id);
        }
        if (dups.size) dupReports.push(`${shop.name || shop.key}：${[...dups].join('、')}`);
      }
      if (dupReports.length) {
        sendJson(res, 400, { error: `店铺内商品 ID 重复，已拦截保存：${dupReports.join('；')}。请删除重复行后再保存。` });
        return;
      }
      const config = readConfig();
      // 保存前的快照：用于判断本次是否真有修改（无修改时不写文件、不备份、不记操作日志、不同步计划任务）。
      const prevConfig = JSON.parse(JSON.stringify(config));
      if (body.intervalMinutes !== undefined) config.intervalMinutes = Math.max(1, numberOr(body.intervalMinutes, 30));
      if (body.anomalyRepeatMinutes !== undefined) config.anomalyRepeatMinutes = Math.max(0, numberOr(body.anomalyRepeatMinutes, 120));
      // 自动任务：每日简报 / 定时重启（开关 + 时间，时间格式 HH:MM）
      if (body.dailyReportEnabled !== undefined) config.dailyReportEnabled = body.dailyReportEnabled === true;
      if (body.dailyReportTime !== undefined) config.dailyReportTime = String(body.dailyReportTime || '').trim();
      if (body.autoRestartEnabled !== undefined) config.autoRestartEnabled = body.autoRestartEnabled === true;
      if (body.autoRestartTime !== undefined) config.autoRestartTime = String(body.autoRestartTime || '').trim();
      // 日报钉钉推送开关：默认关闭（日报写入信息看板），用户可自行开启同步推送到钉钉。
      if (body.dailyReportDingTalk !== undefined) {
        if (typeof body.dailyReportDingTalk !== 'boolean') throw new Error('dailyReportDingTalk 必须是布尔值');
        config.dailyReportDingTalk = body.dailyReportDingTalk;
      }
      // 免打扰时段：形如 "23:00-08:00"（可跨天），留空=不启用。静默期内黄级商品异常不推钉钉，红级店铺故障照常推送。
      // 时间须为合法时:分（00:00~23:59），否则静默期内计算会失效。
      if (body.quietHours !== undefined) {
        const qh = String(body.quietHours || '').trim();
        if (qh && !/^([01]?\d|2[0-3]):[0-5]\d\s*-\s*([01]?\d|2[0-3]):[0-5]\d$/.test(qh)) {
          throw new Error('免打扰时段格式不对：应形如 "23:00-08:00"（可跨天，时间须在 00:00~23:59 内），留空表示不启用');
        }
        config.quietHours = qh;
      }
      // 负责人 → 钉钉手机号映射（报警时 @ 负责人用）。
      let ownerPhonesNormalized = null;
      if (body.ownerPhones !== undefined) {
        if (typeof body.ownerPhones !== 'object' || Array.isArray(body.ownerPhones) || body.ownerPhones === null) {
          throw new Error('ownerPhones 必须是「姓名: 手机号」的对象');
        }
        const ownerPhones = {};
        for (const [name, phone] of Object.entries(body.ownerPhones)) {
          const key = String(name || '').trim();
          // 自动清洗：+86-/86- 前缀、空格横杠都去掉，只留手机号本身。
          const value = normalizePhone(phone);
          if (!key && !value) continue;
          if (!key) throw new Error('负责人手机号映射里存在姓名为空的行');
          if (!value) throw new Error(`负责人「${key}」的手机号格式不对：${String(phone || '').trim() || '空'}（只需填 11 位手机号，如 13812345678）`);
          ownerPhones[key] = value;
        }
        ownerPhonesNormalized = ownerPhones;
        config.ownerPhones = ownerPhones;
      }
      // 无实际修改时不重复保存：不写文件（也就不会产生备份）、不同步计划任务、不记操作日志。
      const shopDiff = diffShops(prevConfig.shops || [], shops);
      const shopFieldChanged = shopFieldsChanged(prevConfig.shops || [], shops);
      const intervalChanged = body.intervalMinutes !== undefined && Number(body.intervalMinutes) !== prevConfig.intervalMinutes;
      const anomalyChanged = body.anomalyRepeatMinutes !== undefined && Number(body.anomalyRepeatMinutes) !== prevConfig.anomalyRepeatMinutes;
      const reportEnabledChanged = body.dailyReportEnabled !== undefined && body.dailyReportEnabled !== prevConfig.dailyReportEnabled;
      const reportTimeChanged = body.dailyReportTime !== undefined && String(body.dailyReportTime || '').trim() !== String(prevConfig.dailyReportTime || '').trim();
      const restartEnabledChanged = body.autoRestartEnabled !== undefined && body.autoRestartEnabled !== prevConfig.autoRestartEnabled;
      const restartTimeChanged = body.autoRestartTime !== undefined && String(body.autoRestartTime || '').trim() !== String(prevConfig.autoRestartTime || '').trim();
      const ownerChanged = ownerPhonesNormalized !== null && !ownerPhonesEqual(ownerPhonesNormalized, prevConfig.ownerPhones || {});
      const reportDingChanged = body.dailyReportDingTalk !== undefined && body.dailyReportDingTalk !== prevConfig.dailyReportDingTalk;
      const quietChanged = body.quietHours !== undefined && String(body.quietHours || '').trim() !== String(prevConfig.quietHours || '').trim();
      if (!shopDiff && !shopFieldChanged && !intervalChanged && !anomalyChanged && !reportEnabledChanged && !reportTimeChanged && !restartEnabledChanged && !restartTimeChanged && !ownerChanged && !reportDingChanged && !quietChanged) {
        sendJson(res, 200, { ok: true, unchanged: true, message: '配置无任何修改，未重复保存。' });
        return;
      }
      writeConfig(mergeConfig(config, shops));
      // 计划任务只在「日报/重启 开关或时间」实际变化时才同步对应任务：改商品、间隔等不碰计划任务，
      // 避免每次保存都把计划任务删了重建（多余且有瞬时失败风险）；日报和重启互不影响，哪个变了同步哪个。
      const scheduleKeys = [];
      if (reportEnabledChanged || reportTimeChanged) scheduleKeys.push('dailyReport');
      if (restartEnabledChanged || restartTimeChanged) scheduleKeys.push('autoRestart');
      const scheduleResult = scheduleKeys.length
        ? await applyScheduleTasks(config, scheduleKeys).catch((error) => [`计划任务同步失败：${error.message || error}`])
        : [];
      // 操作日志只记录实际修改项；未变化的固定字段（店铺总数、间隔、自动任务状态等）不显示，避免每条日志雷同。
      const detailParts = [];
      if (intervalChanged) detailParts.push('间隔 ' + config.intervalMinutes + ' 分钟');
      if (anomalyChanged) detailParts.push('异常重复间隔 ' + config.anomalyRepeatMinutes + ' 分钟');
      if (reportEnabledChanged || reportTimeChanged) detailParts.push('日报 ' + (config.dailyReportEnabled !== false ? '已启用（每天 ' + (String(config.dailyReportTime || '').trim() || '21:00') + '）' : '已停用'));
      if (restartEnabledChanged || restartTimeChanged) detailParts.push('重启 ' + (config.autoRestartEnabled !== false ? '已启用（每天 ' + (String(config.autoRestartTime || '').trim() || '04:00') + '）' : '已停用'));
      if (ownerChanged) detailParts.push('负责人手机号已更新');
      if (reportDingChanged) detailParts.push('日报钉钉推送' + (config.dailyReportDingTalk ? '已开启' : '已关闭'));
      if (quietChanged) detailParts.push('免打扰时段' + (String(config.quietHours || '').trim() ? ' ' + String(config.quietHours).trim() : '已关闭'));
      if (shopDiff) detailParts.push(shopDiff);
      const scheduleFailures = (scheduleResult || []).filter((r) => /失败|格式不对/.test(r));
      if (scheduleFailures.length) detailParts.push('自动任务：' + scheduleFailures.join('、'));
      logOperation('保存配置', detailParts.join('；'), getOperator(req));
      // 保存后自动提交版本库留痕（失败不影响保存；config.json 的 backup 文件已被 .gitignore 排除）。
      try {
        const gitBin = 'C:\\Program Files\\Git\\cmd\\git.exe';
        const g1 = spawn(gitBin, ['add', '-A'], { cwd: ROOT, windowsHide: true });
        g1.on('error', () => {});
        g1.on('close', () => {
          const g2 = spawn(gitBin, ['commit', '-m', 'auto commit ' + new Date().toLocaleString('zh-CN', { hour12: false }), '--quiet'], { cwd: ROOT, windowsHide: true });
          g2.on('error', () => {});
        });
      } catch (_) {}
      sendJson(res, 200, { ok: true, scheduleResult });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run-once') {
      const result = await runOnce();
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    // 取消正在运行的手动检测。
    if (req.method === 'POST' && url.pathname === '/api/run-cancel') {
      const cancelled = cancelRunOnce();
      sendJson(res, 200, { ok: cancelled, output: cancelled ? '已发送取消指令' : '当前没有正在运行的手动检测' });
      return;
    }
    // 手动检测运行状态（前端用来显示/隐藏「取消检测」按钮）。
    if (req.method === 'GET' && url.pathname === '/api/run-state') {
      sendJson(res, 200, { busy: runOnceBusy });
      return;
    }
    // 单店铺检测：只跑指定店铺，结果与上一轮全量结果合并。
    if (req.method === 'POST' && url.pathname === '/api/run-shop') {
      const body = JSON.parse(await readBody(req) || '{}');
      const shopKey = String(body.shopKey || '').trim();
      if (!shopKey) {
        sendJson(res, 400, { error: '缺少 shopKey 参数' });
        return;
      }
      const config = readConfig();
      const shop = (config.shops || []).find((item) => String(item.key || '') === shopKey);
      if (!shop) {
        sendJson(res, 404, { error: `店铺 ${shopKey} 不存在` });
        return;
      }
      const result = await runOnce(shopKey);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    // 启动器.html 使用的存活探测接口（兼容保留；顺带返回局域网地址供启动器动态展示）。
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const lanIps = Object.values(os.networkInterfaces())
        .flat()
        .filter((item) => item && item.family === 'IPv4' && !item.internal)
        .map((item) => item.address);
      sendJson(res, 200, { ok: true, server: 'admin-server', time: new Date().toLocaleString('zh-CN', { hour12: false }), lanIps });
      return;
    }
    // 启动器.html 使用的监控服务状态接口：常驻自动巡检是否在运行、是否被暂停、最近一轮检测时间。
    if (req.method === 'GET' && url.pathname === '/api/monitor/status') {
      checkDaemonMonitor().then((pid) => {
        let lastTime = '';
        try {
          const logPath = path.join(ROOT, 'logs', 'monitor.log');
          if (fs.existsSync(logPath)) {
            const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
            if (lines.length) {
              const m = lines[lines.length - 1].match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
              if (m) lastTime = m[1];
            }
          }
        } catch (_) {}
        sendJson(res, 200, {
          running: Boolean(pid),
          pid: pid || null,
          paused: fs.existsSync(PAUSE_FLAG_PATH),
          lastLogTime: lastTime
        });
      }).catch(() => sendJson(res, 200, { running: false, paused: fs.existsSync(PAUSE_FLAG_PATH), lastLogTime: '' }));
      return;
    }
    // 启动监控服务（只补拉起缺失的常驻 monitor；admin-server 能响应请求说明本进程活着，无需自启）。
    // 用临时 VBS 隐藏窗口启动（与守护脚本同机制），启动后立即删除临时文件。
    if (req.method === 'POST' && url.pathname === '/api/service/start') {
      checkDaemonMonitor().then((pid) => {
        if (pid) {
          sendJson(res, 200, { ok: true, alreadyRunning: true, message: '监控服务已在运行（PID ' + pid + '）。' });
          return;
        }
        const vbsPath = path.join(ROOT, 'tmp-start-monitor.vbs');
        const vbs = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WshShell.CurrentDirectory = "' + ROOT.replace(/\\/g, '\\\\') + '"',
          'WshShell.Run "cmd /c node monitor.js", 0, False',
        ].join('\r\n');
        try {
          fs.writeFileSync(vbsPath, vbs, 'utf8');
          const child = spawn('wscript.exe', [vbsPath], { windowsHide: true });
          child.on('error', (error) => { sendJson(res, 500, { ok: false, error: '启动失败：' + (error.message || error) }); });
          child.on('exit', () => { try { fs.unlinkSync(vbsPath); } catch (_) {} });
          sendJson(res, 200, { ok: true, message: '已发起监控服务启动（隐藏窗口），约几秒后开始运行。' });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: '启动失败：' + (error.message || error) });
        }
      }).catch((error) => sendJson(res, 500, { ok: false, error: '启动失败：' + (error.message || error) }));
      return;
    }
    // 停止监控服务（monitor + admin-server 一并停止；本进程会被结束，先响应再执行）。
    if (req.method === 'POST' && url.pathname === '/api/service/stop') {
      const psCmd = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*monitor.js*' -or $_.CommandLine -like '*admin-server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
      child.on('error', () => {});
      sendJson(res, 200, { ok: true, message: '已发送停止指令：监控服务与管理后台将停止（约 1 秒后生效）。' });
      return;
    }
    // 暂停/恢复自动检测：通过 data/monitor-paused.flag 标志文件与监控守护进程通信。
    if (req.method === 'GET' && url.pathname === '/api/monitor-state') {
      sendJson(res, 200, { paused: fs.existsSync(PAUSE_FLAG_PATH) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/monitor-state') {
      const body = JSON.parse(await readBody(req) || '{}');
      const paused = body.paused === true;
      fs.mkdirSync(path.dirname(PAUSE_FLAG_PATH), { recursive: true });
      if (paused) {
        fs.writeFileSync(PAUSE_FLAG_PATH, `paused at ${new Date().toISOString()}\n`, 'utf8');
      } else {
        try { fs.unlinkSync(PAUSE_FLAG_PATH); } catch (_) {}
      }
      sendJson(res, 200, { ok: true, paused });
      return;
    }

    // 一键恢复超级立减活动网址（双重确认由前端完成，此处只负责写回）
    if (req.method === 'POST' && url.pathname === '/api/restore-super-deal-urls') {
      const config = readConfig();
      const shops = Array.isArray(config.shops) ? config.shops : [];
      const restored = [];
      const skipped = [];
      for (const shop of shops) {
        const preset = SUPER_DEAL_URLS[shop.key];
        if (!preset) { skipped.push(shop.key); continue; }
        shop.activityUrl = preset;
        restored.push(shop.key);
      }
      writeConfig(config);
      logOperation('恢复超级立减网址', '恢复 ' + restored.length + ' 个店铺' + (skipped.length ? '，跳过 ' + skipped.join('、') : ''), getOperator(req));
      sendJson(res, 200, { ok: true, restored, skipped, message: '已恢复 ' + restored.length + ' 个店铺的超级立减活动网址' + (skipped.length ? '，跳过未预设的店铺：' + skipped.join('、') : '') });
      return;
    }
    // 查看监控服务状态由 /api/monitor/status 承担（检查常驻进程，而非本服务自管的子进程）。
    if (req.method === 'POST' && url.pathname === '/api/import') {
      const buffer = await readBodyBuffer(req);
      const { items, errors } = parseImportWorkbook(buffer);
      const config = readConfig();
      const summary = applyImport(config, items);
      writeConfig(config);
      logOperation('导入配置', '新增店铺 ' + summary.shopsAdded + '，新增商品 ' + summary.productsAdded + '，更新 ' + summary.productsUpdated, getOperator(req));
      sendJson(res, 200, { ok: true, ...summary, errors });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/template') {
      // 动态生成导入模板：表头 + 1 行示例（页面显示的列在前，可不填的列标注并放最后）。
      try {
        let XLSX;
        try { XLSX = require('xlsx'); } catch (_) { sendJson(res, 500, { error: '缺少 xlsx 依赖，请先运行 npm install' }); return; }
        const headers = [
          '店铺编号*', '店铺名称*', '商品ID*', '商品标题', '活动名称', '活动页URL',
          '活动截止时间', '负责人', '监控开始时间', '监控模式', '启用状态',
          '下线活动关键词（可不填）', '恢复成功关键词（可不填）', '容差分钟（可不填）', '活动价(元)（可不填）', '库存下限(件)（可不填）',
        ];
        const rows = [
          headers,
          ['shop01', '示例旗舰店', '1234567890123', '示例商品标题', '10月超级88', 'https://myseller.taobao.com/home.htm', '2026-10-31', '张三', '2026-10-01', '添加时间', '启用', '', '', '', '', ''],
        ];
        const guide = [
          ['淘宝/天猫 活动监控 — 商品导入模板 填写说明'],
          [],
          ['1. 带 * 的列为必填：店铺编号、商品ID。'],
          ['2. 店铺编号：同一个店铺填同一个编号（只用数字/字母/中划线），不同商品会自动归到同一店铺下。'],
          ['3. 活动页URL：该商品报名的活动报名记录页链接。'],
          ['   ★ 一个店铺有多个活动时，给每个商品填上各自的活动页URL，即可分别检测不同活动；'],
          ['   ★ 留空则使用店铺默认的活动链接（网页管理里店铺上的「活动链接」）。'],
          ['4. 导入后：新增店铺会创建，新增商品会添加，已存在的商品ID会更新为本次填写的配置。'],
          ['5. 启用状态填「启用/停用」；监控模式填「报名时间/添加时间」。'],
          ['6. 最后 5 列为可不填（网页管理里不显示），留空即可：下线活动关键词、恢复成功关键词、容差分钟、活动价(元)、库存下限(件)。'],
          ['7. 示例行（shop01）导入前请删除。'],
        ];
        const wsData = XLSX.utils.aoa_to_sheet(rows);
        wsData['!cols'] = headers.map((h) => ({ wch: h.length >= 4 ? Math.max(14, h.length + 2) : 10 }));
        const wsGuide = XLSX.utils.aoa_to_sheet(guide);
        wsGuide['!cols'] = [{ wch: 90 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, wsGuide, '填写说明');
        XLSX.utils.book_append_sheet(wb, wsData, '导入数据');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('商品导入模板.xlsx')}`,
        });
        res.end(buf);
      } catch (e) {
        sendJson(res, 500, { error: '模板生成失败：' + e.message });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/results') {
      // 操作日志已独立为 /api/operations（信息看板页用），此处只返回检测结果与日志。
      sendJson(res, 200, { results: readResults(), logTail: readLogTail(80), logLines: parseLogTail(readLogTail(800)) });
      return;
    }
    // 单独拉取操作日志（支持 limit 条数、date 按日期筛选，如 date=2026-10-08）
    if (req.method === 'GET' && url.pathname === '/api/operations') {
      sendJson(res, 200, { operations: readOperations(Number(url.searchParams.get('limit') || 50), url.searchParams.get('date') || '') });
      return;
    }
    // 检测历史（趋势看板数据）：monitor 每轮写入 data/detect-history.json，这里返回最近 N 轮。
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const limit = Math.max(2, Math.min(500, Number(url.searchParams.get('limit') || 100)));
      let history = [];
      try {
        const histPath = path.join(ROOT, 'data', 'detect-history.json');
        if (fs.existsSync(histPath)) {
          history = JSON.parse(fs.readFileSync(histPath, 'utf8'));
          if (!Array.isArray(history)) history = [];
        }
      } catch (_) { history = []; }
      sendJson(res, 200, { history: history.slice(-limit) });
      return;
    }
    // 信息看板：服务自动恢复事件 + 每日日报（monitor 写 service-events.json，daily-report.js 写 daily-reports.json）
    if (req.method === 'GET' && url.pathname === '/api/board') {
      let serviceEvents = [];
      try {
        const eventsPath = path.join(ROOT, 'data', 'service-events.json');
        if (fs.existsSync(eventsPath)) {
          serviceEvents = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
          if (!Array.isArray(serviceEvents)) serviceEvents = [];
        }
      } catch (_) { serviceEvents = []; }
      let dailyReports = [];
      try {
        const reportsPath = path.join(ROOT, 'data', 'daily-reports.json');
        if (fs.existsSync(reportsPath)) {
          const reports = JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
          if (reports && typeof reports === 'object' && !Array.isArray(reports)) {
            dailyReports = Object.values(reports).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
          }
        }
      } catch (_) { dailyReports = []; }
      sendJson(res, 200, { serviceEvents: serviceEvents.slice(-100), dailyReports });
      return;
    }
    // 导出检测日志（默认最近一小时）
    if (req.method === 'GET' && url.pathname === '/api/export-log') {
      const minutes = Math.max(1, Math.min(1440, Number(url.searchParams.get('minutes') || 60)));
      const raw = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
      const cutoff = Date.now() - minutes * 60 * 1000;
      const lines = String(raw).split('\n').filter(Boolean).filter((line) => {
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
        if (!m) return false;
        const t = new Date(m[1].replace(' ', 'T'));
        return t.getTime() >= cutoff;
      });
      const label = minutes === 60 ? '一小时' : (minutes + '分钟');
      const content = lines.length
        ? lines.join('\n')
        : `（最近 ${label} 暂无日志）`;
      const fileName = `监控日志-最近${label}.txt`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fileName),
      });
      res.end(content);
      return;
    }
    sendJson(res, 404, { error: '接口不存在' });
  } catch (error) {
    sendJson(res, 400, { error: error.message || String(error) });
  }
};

// 外网入口端口处理：先过花名拦截，通过后复用主 handler。
const interceptHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/intercept-auth') {
    let body = {};
    try { body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}'); } catch (_) {}
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: '请输入花名' });
    if (!ownerNameSet().has(name)) return sendJson(res, 403, { error: '花名不正确，无法进入' });
    const secret = getInterceptSecret();
    const value = String(Date.now());
    const token = `${value}.${signInterceptToken(value, secret)}`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${INTERCEPT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (!interceptAuthorized(req)) {
    // 页面请求返回拦截页；API 请求返回 401（前端轮询会被浏览器拦住，不发数据）。
    const wantsHtml = String(req.headers.accept || '').includes('text/html') || url.pathname === '/';
    if (wantsHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(interceptPageHtml());
    } else {
      sendJson(res, 401, { error: '未授权，请先在外网入口页输入花名' });
    }
    return;
  }
  return mainHandler(req, res);
};

const server = http.createServer(mainHandler);
server.listen(PORT, HOST, () => {
  console.log(`网页管理后台已启动：http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && item.family === 'IPv4' && !item.internal)
      .map((item) => item.address);
    for (const ip of ips) {
      console.log(`局域网分享地址（发给同事）：http://${ip}:${PORT}`);
    }
    console.log(ADMIN_TOKEN
      ? '已启用管理口令（adminToken），同事打开页面后需输入口令才能操作。'
      : '⚠️ 未设置 adminToken，同一网络的人都能修改配置，建议在 config.json 里加 "adminToken"。');
  }
  console.log('在浏览器里打开上面的地址即可管理店铺和商品。按 Ctrl+C 停止。');
});
// 端口被占用时明确提示并退出：守护脚本误判重复拉起时，避免第二个进程无声崩溃、避免双后台并存。
server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被其他进程占用（可能已有 admin-server 在运行），本进程退出。`);
  } else {
    console.error('admin-server 启动失败：' + (error && error.message ? error.message : String(error)));
  }
  process.exit(1);
});

// 外网入口端口（花名拦截）：config.interceptPort 默认 3081，监听 0.0.0.0 供内网穿透指向；局域网访问主端口不受影响。
// 设为 0 或删除即不启动拦截入口（当前走零信任+局域网方案，公网入口已关闭）。
const interceptPort = Number(readConfig().interceptPort || 0);
if (interceptPort > 0) {
  const interceptServer = http.createServer(interceptHandler);
  interceptServer.listen(interceptPort, '0.0.0.0', () => {
    console.log(`外网入口（花名拦截）已启动：http://0.0.0.0:${interceptPort}（供内网穿透指向；局域网访问主端口 ${PORT} 免拦截）`);
  });
  interceptServer.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`外网入口端口 ${interceptPort} 已被占用，拦截入口未启动（可改 config.json 的 interceptPort）。`);
    } else {
      console.error('外网入口启动失败：' + (error && error.message ? error.message : String(error)));
    }
  });
} else {
  console.log('外网入口（花名拦截）未启用（config.interceptPort 未配置），仅局域网端口 ' + PORT + ' 免拦截访问。');
}
