'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { sendNotification, hasNotificationChannel, notificationChannelLabel, normalizeNotificationConfig } = require('./notifier');
const { attemptPasswordLogin } = require('./password-login');

const ROOT = __dirname;
const CONFIG_PATH = process.env.TB_CONFIG || path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_PATH = path.join(DATA_DIR, 'last-results.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
// 暂停标志文件：网页管理端「停止检测」写入该文件，守护进程检测到后暂停自动巡检；「恢复检测」删除它。
const PAUSE_FLAG_PATH = path.join(DATA_DIR, 'monitor-paused.flag');
const DEFAULT_ACTIVITY_URL = 'https://myseller.taobao.com/home.htm';
// 代码版本号：启动时写入日志、每轮写入检测结果。怀疑“改了半天没生效”时，先看网页上显示的版本号是不是最新的。
const MONITOR_VERSION = '2026-10-09';
let running = false;
let stopRequested = false;

function isMonitorPaused() {
  try { return fs.existsSync(PAUSE_FLAG_PATH); } catch (_) { return false; }
}

// 磁盘占用治理：日志只保留 48 小时；monitor.log 超过 20MB 轮转成 monitor.old.log（旧档直接覆盖）。
const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 20 * 1024 * 1024;

async function cleanupStorage() {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  let removed = 0;
  try {
    for (const name of await fsp.readdir(LOG_DIR)) {
      if (name === 'monitor.log') continue;
      const full = path.join(LOG_DIR, name);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fsp.unlink(full);
          removed += 1;
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const mainLog = path.join(LOG_DIR, 'monitor.log');
    const stat = await fsp.stat(mainLog);
    if (stat.size > LOG_MAX_BYTES) {
      const oldLog = path.join(LOG_DIR, 'monitor.old.log');
      try { await fsp.unlink(oldLog); } catch (_) {}
      await fsp.rename(mainLog, oldLog);
    }
  } catch (_) {}
  if (removed > 0) await log('info', `存储清理完成：删除 ${removed} 个 48 小时前的日志/截图文件。`);
}

let lastCleanupAt = 0;
async function cleanupStorageOncePerHour() {
  if (Date.now() - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = Date.now();
  await cleanupStorage().catch(() => {});
}

// ===== 服务自动恢复记录（信息看板） =====
// 守护脚本（开机自启/计划任务）拉起服务时会在 data/ 写 flag-recovered-*.flag；
// monitor 每轮检查到标记 → 记录到 data/service-events.json（信息看板展示，不再发钉钉）→ 删除标记。
const SERVICE_EVENTS_PATH = path.join(DATA_DIR, 'service-events.json');

async function appendServiceEvent(event) {
  try {
    let list = [];
    try { list = JSON.parse(await fsp.readFile(SERVICE_EVENTS_PATH, 'utf8')); } catch (_) {}
    if (!Array.isArray(list)) list = [];
    list.push(event);
    while (list.length > 100) list.shift();
    await fsp.writeFile(SERVICE_EVENTS_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (error) {
    await log('error', `写入服务恢复事件失败：${error.message || error}`);
  }
}

async function checkRecoveredFlags() {
  let flags = [];
  try { flags = await fsp.readdir(DATA_DIR); } catch (_) { return; }
  const recovered = flags.filter((name) => name.startsWith('flag-recovered-'));
  if (!recovered.length) return;
  const names = recovered.map((name) => {
    const target = name.replace('flag-recovered-', '').replace(/\.flag$/i, '');
    return target === 'admin' ? '管理后台(admin-server)' : target === 'monitor' ? '监控服务(monitor)' : target;
  });
  const message = `【服务自动恢复】${names.join('、')} 曾被检测到未运行，守护脚本已自动拉起，服务恢复正常。`;
  await appendServiceEvent({ time: localNow(), service: names.join('、'), message });
  await log('alarm', `服务自动恢复已记录到信息看板：${names.join('、')}。`);
  for (const name of recovered) {
    try { await fsp.unlink(path.join(DATA_DIR, name)); } catch (_) {}
  }
}

function localNow() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

// 免打扰时段：config.quietHours 形如 "23:00-08:00"（支持跨天）。静默期内黄级商品异常不推钉钉，
// 红级店铺故障（登录风控/页面加载失败等）不受影响照常推送；检测与记录始终进行。
// 时间须为合法时:分（00:00~23:59）；配置非法时视为未启用，避免静默失效。
function isInQuietHours(config, nowDate) {
  const raw = String((config && config.quietHours) || '').trim();
  if (!raw) return false;
  const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const d = nowDate || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function ensureDirs() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function log(level, message, extra) {
  await ensureDirs();
  const line = `[${localNow()}] [${String(level).toUpperCase()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  await fsp.appendFile(path.join(LOG_DIR, 'monitor.log'), `${line}\n`, 'utf8');
}

// 手机号归一化：去掉 +86/86 国家码前缀和所有非数字字符（空格、横杠），返回 5~15 位纯数字；不合法返回空串。
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
  return /^\d{5,15}$/.test(digits) ? digits : '';
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['added_time', 'added', 'join', '按加入时间', '加入名单后'].includes(normalized)) return 'added_time';
  return 'signup_date';
}

function enabledValue(value) {
  return value !== false && !/^(no|否|false|0|停用|暂停)$/i.test(String(value == null ? 'yes' : value));
}

function normalizeProduct(item, shopName) {
  const product = { ...item };
  product.shopName = shopName || product.shopName || product.shop_name || product.shop || '';
  product.productId = String(product.productId || product.product_id || product.id || '').trim();
  product.productName = product.productName || product.product_name || product.name || '';
  product.activityName = String(product.activityName || product.activity_name || '').trim();
  product.activityUrl = String(product.activityUrl || product.activity_url || '').trim();
  // 活动截止时间：按活动维度控制，截止时间后停止一切异常报警。
  product.activityDeadline = String(product.activityDeadline || product.activity_deadline || '').trim();
  product.owner = String(product.owner || product.responsiblePerson || product.responsible || '').trim();
  product.monitorMode = normalizeMode(product.monitorMode || product.monitor_mode || 'signup_date');
  product.monitorSince = String(product.monitorSince || product.monitor_since || '').trim();
  product.monitorActivityKeywords = String(
    product.monitorActivityKeywords || product.monitor_activity_keywords || product.activityKeywords || ''
  ).trim();
  product.recoveryActivityKeywords = String(
    product.recoveryActivityKeywords || product.recovery_activity_keywords || ''
  ).trim();
  product.recoveryGraceMinutes = Math.max(
    0,
    Math.min(1440, Number(product.recoveryGraceMinutes || product.recovery_grace_minutes || 0) || 0),
  );
  product.expectedPrice = Math.max(0, Number(product.expectedPrice || product.expected_price || 0) || 0);
  product.minStock = Math.max(0, Number(product.minStock || product.min_stock || 0) || 0);
  product.priceTolerance = Math.max(0, Number(product.priceTolerance || product.price_tolerance || 0.01) || 0);
  if (product.monitorMode === 'added_time' && !product.monitorSince) product.monitorSince = localNow();
  product.enabled = enabledValue(product.enabled);
  return product;
}

function normalizeShop(item, index, config) {
  const shop = { ...item };
  shop.key = String(shop.key || shop.shopKey || shop.id || `shop${String(index + 1).padStart(2, '0')}`).trim();
  // 去掉配置时误输入的首尾装饰括号，避免与页面显示名永远匹配不上。
  shop.name = String(shop.name || shop.shopName || shop.shop_name || `店铺${index + 1}`).trim().replace(/^[【\[]+|[】\]]+$/g, '');
  shop.profileDir = String(shop.profileDir || shop.profile_dir || path.join(ROOT, 'profiles', shop.key)).trim();
  shop.activityUrl = String(shop.activityUrl || shop.activity_url || config.activityUrl || DEFAULT_ACTIVITY_URL).trim();
  // 账号密码自动登录（可选）：掉线时自动尝试密码登录，遇到滑块/短信需人工在浏览器窗口完成。
  shop.account = String(shop.account || '').trim();
  shop.password = String(shop.password || '');
  shop.chromeDebugPort = Math.max(0, Math.min(65535, Number(shop.chromeDebugPort) || 0));
  shop.enabled = enabledValue(shop.enabled);
  shop.verifyShopName = shop.verifyShopName !== false;
  shop.products = (Array.isArray(shop.products) ? shop.products : []).map((product) => normalizeProduct(product, shop.name));
  return shop;
}

async function loadConfig() {
  let raw;
  try {
    raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  } catch (_) {
    throw new Error(`配置文件不存在：${CONFIG_PATH}。请先运行 node configure.js`);
  }
  const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  config.activityUrl = config.activityUrl || DEFAULT_ACTIVITY_URL;
  const notification = normalizeNotificationConfig(config);
  config.dingtalk = notification.dingtalk;
  config.intervalMinutes = Math.max(Number(config.intervalMinutes) || 30, 1);
  config.headless = config.headless !== false;
  // 内置浏览器可执行文件路径：默认使用 Playwright 自带 Chromium；如需用系统 Chrome，可配置为 chrome.exe 路径。
  config.chromeExecutablePath = String(config.chromeExecutablePath || '').trim() || undefined;
  config.notifyOnError = config.notifyOnError !== false;
  // 恢复通知默认关闭：只有异常状态才发钉钉提醒（商品恢复、店铺恢复都不发）。
  config.notifyProductRecovery = config.notifyProductRecovery === true;
  config.notifyShopRecovery = config.notifyShopRecovery === true;
  config.errorAlertCooldownMinutes = Math.max(Number(config.errorAlertCooldownMinutes) || 180, 30);
  // 0 是合法值（异常期间每轮都提醒，不去重），不能用 || 设默认值，否则 0 会被吞掉。
  config.anomalyRepeatMinutes = (config.anomalyRepeatMinutes === 0 || config.anomalyRepeatMinutes === '0')
    ? 0
    : Math.max(Number(config.anomalyRepeatMinutes) || 30, 0);
  // 负责人 → 钉钉手机号映射：异常报警时 @ 对应负责人（钉钉的 @ 必须用绑定的手机号）。
  // 自动清洗写法差异：+86-/86- 前缀、空格横杠都会去掉，只留手机号本身。
  const ownerPhones = {};
  if (config.ownerPhones && typeof config.ownerPhones === 'object' && !Array.isArray(config.ownerPhones)) {
    for (const [name, phone] of Object.entries(config.ownerPhones)) {
      const key = String(name || '').trim();
      const value = normalizePhone(phone);
      if (key && value) ownerPhones[key] = value;
    }
  }
  config.ownerPhones = ownerPhones;
  config.transientRetryAttempts = Math.max(2, Math.min(3, Number(config.transientRetryAttempts) || 2));
  config.transientRetryDelaySeconds = Math.max(1, Math.min(30, Number(config.transientRetryDelaySeconds) || 3));
  // 浏览器模式：builtin=内置 Chromium（默认，适合 Linux 服务器）；cdp=连接本机已打开的 Chrome（适合 Windows，会话更稳定）。
  config.browserMode = String(config.browserMode || 'builtin').trim().toLowerCase() === 'cdp' ? 'cdp' : 'builtin';
  config.chromeDebugPort = Math.max(1024, Math.min(65535, Number(config.chromeDebugPort) || 9222));
  // 查询等待：最长等待秒数（容忍网络卡顿）；“暂无数据”需连续稳定秒数才采信为空结果。
  config.queryTimeoutSeconds = Math.max(10, Math.min(120, Number(config.queryTimeoutSeconds) || 30));
  config.emptyConfirmSeconds = Math.max(3, Math.min(30, Number(config.emptyConfirmSeconds) || 8));
  // 掉线自动重登：店铺配置了账号密码时默认开启；无界面（headless）时遇到风控无法人工兜底，自动关闭人工等待。
  config.autoRelogin = config.autoRelogin !== false;
  config.reloginChallengeWaitSeconds = Math.max(30, Math.min(300, Number(config.reloginChallengeWaitSeconds) || 100));
  config.offlineWords = Array.isArray(config.offlineWords) && config.offlineWords.length
    ? config.offlineWords : ['活动下线', '清退'];
  config.successWords = Array.isArray(config.successWords) && config.successWords.length
    ? config.successWords : ['报名成功', '审核通过'];
  config.ongoingWords = Array.isArray(config.ongoingWords) && config.ongoingWords.length
    ? config.ongoingWords : ['报名进行中', '进行中', '活动中'];
  // 报名未完成（草稿/待完善）状态词：商品能搜到但活动未生效，按异常报警。
  config.draftWords = Array.isArray(config.draftWords) && config.draftWords.length
    ? config.draftWords : ['草稿', '待完善', '待提交', '未提交', '待编辑', '待补充'];
  // 状态白名单模式（默认开启）：行状态不含以下任一正常词即报警，草稿/清退/异常/撤销等全覆盖。
  config.normalStatusWords = Array.isArray(config.normalStatusWords) && config.normalStatusWords.length
    ? config.normalStatusWords : ['已发布设定', '报名成功', '审核通过', '报名进行中', '活动中'];
  config.statusWhitelistMode = config.statusWhitelistMode !== false;

  config.shops = (Array.isArray(config.shops) ? config.shops : []).map((shop, index) => normalizeShop(shop, index, config));
  // 为 cdp 模式分配各店铺生效调试端口，算法必须与 start-chrome.js 完全一致：
  // 启用店铺按顺序，显式 chromeDebugPort 优先，未配置则从全局端口起取下一个空闲端口。
  const usedPorts = new Set();
  for (const shop of config.shops) {
    if (!shop.enabled) continue;
    let port = shop.chromeDebugPort || 0;
    if (!port || usedPorts.has(port)) {
      port = config.chromeDebugPort;
      while (usedPorts.has(port)) port += 1;
    }
    usedPorts.add(port);
    shop.chromeDebugPort = port;
  }
  return config;
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_PATH, 'utf8')); } catch (_) { return {}; }
}

async function writeState(state) {
  await ensureDirs();
  await fsp.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

const ANOMALY_LABELS = {
  offline: '活动下线/被清退',
  missing: '商品从活动中消失',
  status: '活动状态异常(非已发布设定)',
  draft: '报名未完成(草稿/待完善)',
  price: '活动价异常',
  stock: '库存异常',
  anomaly: '活动状态异常',
};

function anomalyLabel(type) {
  return ANOMALY_LABELS[type] || type;
}

// 活动名称展示：优先用网页管理里手工填写的活动名称；没填时回退到页面识别文本，
// 但识别文本往往是整行商品标题（又长又乱），截断到 25 字避免报警消息臃肿。
function displayActivityName(item) {
  const manual = String(item.activityName || '').trim();
  if (manual) return manual;
  const fallback = String(item.activityTitle || '').trim();
  if (!fallback) return '未填写';
  return fallback.length > 25 ? `${fallback.slice(0, 25)}…` : fallback;
}

function anomalyDetailLines(item) {
  // 只保留有信息量的动态字段（时间、价格、库存数）；固定套话（下线详情/消失详情）
  // 和与「活动名称」重复的「下线活动」不再发送，避免钉钉消息过长冗余。
  const lines = [];
  if (item.anomalies.includes('offline')) {
    if (item.latestOfflineTime || item.submitTime) lines.push(`   最近下线时间：${item.latestOfflineTime || item.submitTime}`);
    if (item.latestSuccessTime) lines.push(`   最近符合恢复规则的报名成功：${item.latestSuccessTime}`);
  }
  if (item.anomalies.includes('price')) {
    lines.push(`   价格详情：页面活动价 ${item.currentPrice} 元，白名单登记 ${item.expectedPrice} 元（容差 ${item.priceTolerance} 元）`);
  }
  if (item.anomalies.includes('stock')) {
    lines.push(`   库存详情：页面活动库存 ${item.currentStock} 件，低于白名单下限 ${item.minStock} 件`);
  }
  return lines;
}

// 报警明细日志：把本次报警的商品压缩成一行（店铺/ID(名称)[异常类型]），供日报与事后排查直接提取。
// 最多列 20 个，超出以“…等 N 个”收尾，避免单行日志过长。
function alertDetailLog(items) {
  const parts = (items || []).slice(0, 20).map((item) => {
    const typeText = Array.isArray(item.anomalies) ? item.anomalies.map(anomalyLabel).join('/') : '';
    return `${item.shopName || item.shopKey || '未知店铺'}/${item.productId}(${item.productName || '未填名称'})${typeText ? `[${typeText}]` : ''}`;
  });
  if (items.length > 20) parts.push(`…等 ${items.length} 个`);
  return `商品：${parts.join('、')}`;
}

function buildAnomalyMessage(items) {
  const lines = ['#### 【淘宝/天猫商品活动异常报警】', '', `检测时间：${localNow()}`, `异常数量：${items.length}`, ''];
  items.slice(0, 30).forEach((item, index) => {
    // 商品之间插一条分隔线：钉钉 markdown 会把单纯空行压掉，分隔线才能真正拉开间距。
    if (index > 0) lines.push('-----', '');
    lines.push(`${index + 1}. 店铺：${item.shopName || '未填写'}`);
    lines.push(`   商品ID：${item.productId}`);
    lines.push(`   商品名称：${item.productName || '未填写'}`);
    lines.push(`   活动名称：${displayActivityName(item)}`);
    lines.push(`   <font color="#FF0000">负责人：${item.owner || '未填写'}</font>`);
    lines.push(`   异常类型：${item.anomalies.map(anomalyLabel).join('、')}`);
    lines.push(...anomalyDetailLines(item));
    lines.push('');
  });
  if (items.length > 30) lines.push(`还有 ${items.length - 30} 个异常未展开，请查看服务器日志。`);
  lines.push('异常持续期间会按设定间隔重复提醒，恢复正常后自动停止提醒。');
  return lines.join('\n');
}

function buildProductRecoveryMessage(items) {
  const lines = ['【淘宝/天猫商品活动已恢复】', '', `时间：${localNow()}`, `恢复商品：${items.length}`, ''];
  items.slice(0, 30).forEach((item, index) => {
    lines.push(`${index + 1}. 店铺：${item.shopName || '未填写'}`);
    lines.push(`   商品ID：${item.productId}`);
    lines.push(`   商品名称：${item.productName || '未填写'}`);
    lines.push(`   活动名称：${displayActivityName(item)}`);
    lines.push(`   负责人：${item.owner || '未填写'}`);
    lines.push(`   原异常：${(item.previousAnomalies || []).map(anomalyLabel).join('、') || '未知'}`);
    lines.push(`   恢复时间：${localNow()}`);
    if (item.latestSuccessTime) lines.push(`   最近报名成功：${item.latestSuccessTime}`);
    lines.push('');
  });
  lines.push('以上商品活动状态已恢复正常，将停止异常提醒。');
  return lines.join('\n');
}

// 按错误内容归类店铺检测失败的标题与人工动作，避免所有失败都叫"登录异常"、让通知与实际不符。
function classifyShopError(message) {
  const text = String(message || '');
  if (/登录|密码|账号|风控|滑块|短信|验证码|登录状态已失效|直接登录失败|会话被作废/i.test(text)) {
    return { title: '⚠️ 店铺登录异常', action: '请手动登录恢复。' };
  }
  if (/页面未找到「异常」tab（现有：）/.test(text)) {
    return { title: '⚠️ 店铺活动页加载异常', action: '活动页未加载出来（已自动重试仍失败），请人工打开活动页确认页面是否正常。' };
  }
  if (/页面未找到「异常」tab/.test(text)) {
    return { title: '⚠️ 店铺页面结构异常', action: '活动页未找到[异常]tab，疑似淘宝页面改版，请人工确认后更新适配。' };
  }
  if (/店铺名称校验失败/.test(text)) {
    return { title: '⚠️ 店铺名称校验失败', action: '页面店铺与配置名称不符（疑似串店），已跳过，请人工确认。' };
  }
  if (/数量不符|翻页失败/.test(text)) {
    return { title: '⚠️ 店铺异常名单抓取异常', action: '异常名单抓取不完整，请查看服务器日志确认。' };
  }
  return { title: '⚠️ 店铺检测异常', action: '请查看服务器日志确认原因。' };
}

function buildShopErrorMessage(errors) {
  // 按错误类型分组：不同店铺可能因为不同原因失败，标题与人工动作各自对应，不再一刀切叫"登录异常"。
  const groups = new Map();
  for (const item of errors) {
    const cls = classifyShopError(item.error);
    const key = cls.title + '\u0000' + cls.action;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const lines = [];
  let first = true;
  for (const [key, items] of groups) {
    const [title, action] = key.split('\u0000');
    if (!first) lines.push('-----', '');
    first = false;
    lines.push(title, '', `时间：${localNow()}`, `异常店铺：${items.length}个`, '');
    items.slice(0, 15).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.shopName}（${item.shopKey}）`);
    });
    lines.push('', action);
  }
  return lines.join('\n');
}

function buildShopRecoveryMessage(items) {
  const lines = ['✅ 店铺监控已恢复', '', `时间：${localNow()}`, `恢复店铺：${items.length}个`, ''];
  items.slice(0, 15).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.shopName}（${item.shopKey}）`);
  });
  return lines.join('\n');
}

function isTransientBrowserError(error) {
  const text = String(error && (error.message || error) || '');
  return /Target page, context or browser has been closed|target closed|page has been closed|context has been closed|browser has been closed|Navigation failed because page was closed|Protocol error.*Target closed|Execution context was destroyed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(text);
}

// ---- cdp 模式：单个店铺 Chrome 掉线时的针对性自动重连 ----

function findChromeExe() {
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

// 与 start-chrome.js 完全一致的用户目录规则，保证重连/重启的还是原来那个登录态目录。
function shopChromeProfileDir(config, shop) {
  const explicit = String(shop.profileDir || '').trim();
  if (explicit) return explicit;
  const legacyDir = path.join(ROOT, 'chrome-profile');
  const enabledCount = (Array.isArray(config.shops) ? config.shops : []).filter((s) => s && s.enabled !== false).length;
  if (enabledCount === 1 && fs.existsSync(legacyDir)) return legacyDir;
  return path.join(ROOT, `chrome-profile-${shop.key}`);
}

async function isDebugPortUp(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}

// 连续探测 3 次都无响应才认定窗口真的没了（浏览器繁忙时单次探测可能超时误判）。
async function isDebugPortReallyDown(port) {
  for (let i = 0; i < 3; i += 1) {
    if (await isDebugPortUp(port)) return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return true;
}

// 正在重启中的端口集合：防止同一端口并发触发多次 Chrome 启动。
const chromeRestarting = new Set();

// Chrome profile 里的纯缓存目录（不含 Cookies/Login Data/Local Storage，清理不影响登录态）。
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

// 只能在浏览器实例关闭时调用（运行中的实例正在占用这些文件）。
function cleanProfileCache(profileDir) {
  let removed = 0;
  for (const rel of PROFILE_CACHE_DIRS) {
    const full = path.join(profileDir, rel);
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch (_) {}
  }
  return removed;
}

// 页面已打开活动报名页：切换到「异常」tab 并翻页抓取全部异常商品 ID。
// 组件为 Fusion next-tabs（.next-tabs-tab-inner）+ next-pagination（.next-pagination-item.next-next）。
// tab 文本形如「异常」或「异常(33)」；tab 不存在或括号数字为 0 表示当前无异常。
async function scanAnomalyTab(page) {
  const anomalyIds = new Set();
  let scanError = '';
  // 页面异步渲染：状态筛选条（含「异常(N)」）偶尔晚于分类 tab 出现（如创庭 15:15 现场），
  // 轮询等待「异常」tab 出现，最多 15 秒，避免误报“找不到异常tab”。
  const findAnomalyTab = () => page.evaluate(() => {
    const norm = (el) => (el.innerText || '').replace(/\s+/g, '');
    // 收集所有 tab 候选：Fusion next-tabs + 常见 tab 角色/类名。注意创庭等店铺的「异常(1)」状态筛选条
    // 不在 .next-tabs-tab-inner 下，只查该选择器会漏掉独立「异常」tab 导致误报“找不到异常tab”。
    const seen = new Set();
    const candidates = [];
    for (const sel of ['.next-tabs-tab-inner', '.next-tabs-tab', '[role="tab"]', '[class*="tab"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const t = norm(el);
        if (!t || t.length > 30 || seen.has(el)) continue;
        seen.add(el);
        candidates.push({ el, t });
      }
    }
    // 优先「异常」开头的 tab（如「异常(33)」「异常(1)」）；兜底包含「异常」但排除分类 tab（如「风险和异常商品」，
    // 那是商品分类视图，不是异常状态筛选）。
    const t = (candidates.find((c) => c.t.startsWith('异常')) || candidates.find((c) => c.t.includes('异常') && !c.t.includes('商品')) || {}).el;
    if (!t) return { exists: false, tabs: candidates.map((c) => c.t) };
    const label = norm(t);
    const m = label.match(/[（(](\d+)[）)]/);
    const wasActive = t.getAttribute('aria-selected') === 'true' || /active|current|selected/i.test(t.className);
    if (!wasActive) t.click();
    return { exists: true, count: m ? Number(m[1]) : null, label, wasActive };
  });
  let tab = null;
  let lastTabs = [];
  for (let w = 0; w < 15000 && !tab; w += 1000) {
    tab = await findAnomalyTab();
    if (!tab) lastTabs = (await page.evaluate(() => {
      const norm = (el) => (el.innerText || '').replace(/\s+/g, '');
      return Array.from(document.querySelectorAll('.next-tabs-tab-inner')).map(norm);
    }).catch(() => []));
    if (!tab) await page.waitForTimeout(1000);
  }
  if (!tab) return { anomalyIds, error: `页面未找到「异常」tab（现有：${(lastTabs || []).join('/')}）` };
  if (tab.count === 0) return { anomalyIds, declaredCount: 0 };
  // 点击后等待列表真正切换：记录点击前首行商品ID，轮询到首行变化为止（最多 10 秒）。
  // 背景：14:12 创庭曾“抓到 10 个（页面标注 1）”——点击异常 tab 后列表未切换，抓到的是默认列表第一页。
  const firstRowId = () => page.evaluate(() => {
    const tr = document.querySelector('tr.next-table-row');
    const m = tr && (tr.innerText || '').match(/商品ID\s*(\d{10,13})/);
    return m ? m[1] : null;
  }).catch(() => null);
  const beforeFirst = await firstRowId();
  if (!tab.wasActive) {
    // 无数字标注（如「异常」不带 (N)）说明当前没有异常商品：3 秒内确认空列表即可，不必等满 10 秒。
    const waitMs = tab.count === null ? 3000 : 10000;
    let listChanged = false;
    for (let w = 0; w < waitMs; w += 500) {
      await page.waitForTimeout(500);
      const now = await firstRowId();
      // 点击前有行：首行变化才算切换成功；点击前无行（列表还没渲染出来）：
      // 出现首行也算切换成功，避免“点击前首行 无行”把页面加载慢误报成切换失败。
      if (now && (beforeFirst === null || now !== beforeFirst)) { listChanged = true; break; }
    }
    if (!listChanged) {
      if (tab.count === null || tab.count === 0) {
        // 页面未标注异常数量（如「异常」tab 不带数字）= 当前无异常商品，空列表属正常，视为无异常。
        scanError = '';
      } else {
        scanError = beforeFirst === null
          ? `点击「异常」tab 后商品列表未渲染（10 秒内无商品行），页面标注 ${tab.count} 个异常但未加载。`
          : `点击「异常」tab 后列表未切换（点击前首行 ${beforeFirst}）。`;
      }
    }
  }
  await page.waitForTimeout(1500); // 列表渲染稳定

  for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
    const rowIds = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('tr.next-table-row')).filter((el) => el.getBoundingClientRect().width > 0);
      const out = [];
      trs.forEach((el) => {
        const t = el.innerText || '';
        const m = t.match(/商品ID\s*(\d{10,13})/);
        if (m) out.push(m[1]);
      });
      return out;
    });
    rowIds.forEach((id) => anomalyIds.add(id));

    // 主分页状态：页面可能有多个 next-pagination（如顶部迷你"1/1"分页 + 底部主分页），
    // 只认「可见且含页码列表（.next-pagination-list）的最后一个」，避免点到无关分页。
    const mainPager = () => page.evaluate(() => {
      const pagers = Array.from(document.querySelectorAll('.next-pagination')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.querySelector('.next-pagination-list');
      });
      const main = pagers[pagers.length - 1];
      if (!main) return { exists: false };
      const next = main.querySelector('.next-pagination-item.next-next');
      const cur = main.querySelector('.next-pagination-item.next-current');
      // 给主 next 按钮打临时标记，供 Playwright 精确定位点击。
      if (next) next.setAttribute('data-main-next', '1');
      return {
        exists: true,
        pageNo: cur ? Number((cur.innerText || '').trim()) : null,
        nextEnabled: next ? (!next.disabled && !String(next.className || '').includes('disabled')) : false,
      };
    });

    const nextState = await mainPager();
    if (!nextState.exists || !nextState.nextEnabled) break;

    // 翻页：记录主分页当前页码 → 点主分页「下一页」→ 等页码真正变化（防止点击未生效却继续抓同一页）。
    const beforePageNo = nextState.pageNo;
    let moved = false;
    for (let clickTry = 0; clickTry < 3 && !moved; clickTry += 1) {
      try {
        await page.click('[data-main-next="1"]', { timeout: 8000 });
      } catch (_) {
        // 被遮挡等导致 Playwright 点击失败时，用 DOM click 兜底。
        await page.evaluate(() => { const b = document.querySelector('[data-main-next="1"]'); if (b) b.click(); });
      }
      // 等待主分页页码变化，最多 12 秒。
      for (let waited = 0; waited < 12000; waited += 500) {
        await page.waitForTimeout(500);
        const nowState = await mainPager();
        if (nowState.pageNo != null && beforePageNo != null && nowState.pageNo !== beforePageNo) { moved = true; break; }
      }
    }
    if (!moved) {
      // 连点 3 次页码都没变：记下错误并停止本页扫描，已抓到的 ID 仍可用，不把错误污染到商品结果。
      const ids = [...anomalyIds];
      const idList = ids.length > 20 ? ids.slice(0, 20).join('、') + '…（共 ' + ids.length + ' 个）' : ids.join('、');
      scanError = `翻页失败：停留在第 ${beforePageNo} 页，已抓 ${anomalyIds.size} 个（页面标注 ${tab.count}）；ID：${idList}`;
      break;
    }
    await page.waitForTimeout(1500); // 页码变化后等行渲染稳定
  }
  // 用 tab 括号里的异常数量做校验：抓到数与页面标注不符时在后台日志提醒，便于排查翻页/去重问题。
  // 数量不符或翻页失败时同时打印已抓到的 ID 明细（最多 20 个），方便直接核对抓的是哪些商品。
  if (tab.count != null && anomalyIds.size !== tab.count) {
    const ids = [...anomalyIds];
    const idList = ids.length > 20 ? ids.slice(0, 20).join('、') + '…（共 ' + ids.length + ' 个）' : ids.join('、');
    await log('warn', `异常 tab 数量与页面标注不符：抓到 ${anomalyIds.size} 个，页面标注 ${tab.count} 个${scanError ? `；${scanError}` : ''}；ID：${idList}`);
  }
  return { anomalyIds, declaredCount: tab.count, error: scanError };
}

// 翻页增强：单轮扫描若翻页失败或数量与页面标注不符，自动整轮重扫（重新点「异常」tab 回到第一页）。
// 已抓到的异常 ID 跨轮合并保留（Set 去重），异常锁定能力更强——只要出现过就不丢。
async function scanAnomalyTabWithRetry(page, retries = 2) {
  const merged = new Set();
  let declaredCount = null;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const scan = await scanAnomalyTab(page);
    scan.anomalyIds.forEach((id) => merged.add(id));
    if (scan.declaredCount != null) declaredCount = scan.declaredCount;
    if (!scan.error && (scan.declaredCount == null || merged.size === scan.declaredCount)) {
      return { anomalyIds: merged, declaredCount, error: '' };
    }
    lastError = scan.error || (declaredCount != null && merged.size !== declaredCount
      ? `数量不符：抓到 ${merged.size} 个，页面标注 ${declaredCount} 个` : '');
    if (attempt < retries) {
      await log('warn', `异常 tab 扫描第 ${attempt + 1} 次未完整（${lastError}），3 秒后自动重扫…`);
      await page.waitForTimeout(3000);
    }
  }
  await log('warn', `异常 tab 扫描 ${retries + 1} 次仍未完整（${lastError}），使用已抓到的 ${merged.size} 个 ID 继续本轮比对。`);
  return { anomalyIds: merged, declaredCount, error: lastError };
}

// 只重启掉线店铺自己的 Chrome 窗口（独立用户目录 + 调试端口），不影响其他店铺的窗口。
async function ensureShopChrome(config, shop, debugPort) {
  if (!(await isDebugPortReallyDown(debugPort))) return true;
  if (chromeRestarting.has(debugPort)) {
    // 已有另一个回合正在重启该端口，等它就绪后直接复用结果。
    for (let waited = 0; waited < 30000; waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!chromeRestarting.has(debugPort)) break;
    }
    return isDebugPortUp(debugPort);
  }
  const chrome = findChromeExe();
  if (!chrome) {
    await log('warn', `[${shop.name}] 未找到 Chrome 可执行文件，无法自动重启窗口（可设置环境变量 CHROME_PATH 指向 chrome.exe）。`);
    return false;
  }
  const profileDir = shopChromeProfileDir(config, shop);
  fs.mkdirSync(profileDir, { recursive: true });
  await log('warn', `[${shop.name}] 监控专用 Chrome 未打开（调试端口 ${debugPort} 连续 3 次探测无响应），正在单独重启该店铺的窗口…`);
  // 实例已确认不在运行，顺手清掉网页缓存（不影响登录态），防止缓存目录无限膨胀。
  cleanProfileCache(profileDir);
  chromeRestarting.add(debugPort);
  try {
    // 注意：启动参数绝不能带活动页 URL——若该店铺的 Chrome 实例其实还活着，
    // 带 URL 启动会把报名页作为新标签页塞进现有窗口（每误判一次就多一个标签页，越滚越多）。
    // 不带 URL 时，实例已存在则只是唤起窗口，不会新增任何标签页；真正重启后监控会自己 goto 报名页。
    const child = spawn(chrome, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      // 限制磁盘缓存上限，防止缓存目录无限膨胀。
      '--disk-cache-size=104857600',
      '--media-cache-size=52428800',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    // 等端口就绪（最多 25 秒）。
    for (let waited = 0; waited < 25000; waited += 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await isDebugPortUp(debugPort)) {
        await log('info', `[${shop.name}] Chrome 窗口已单独重启并就绪（端口 ${debugPort}），继续检测。`);
        return true;
      }
    }
    await log('error', `[${shop.name}] Chrome 重启后调试端口 ${debugPort} 仍无响应。`);
    return false;
  } catch (error) {
    await log('error', `[${shop.name}] 自动重启 Chrome 失败：${error.message || error}`);
    return false;
  } finally {
    chromeRestarting.delete(debugPort);
  }
}

async function maybeSendErrors(config, errors, state) {
  if (!errors.length || !config.notifyOnError || !hasNotificationChannel(config)) return false;
  const key = errors.map((item) => `${item.shopKey}:${item.error}`).sort().join('|').slice(0, 1200);
  const now = Date.now();
  const cooldown = config.errorAlertCooldownMinutes * 60 * 1000;
  if (state.lastErrorKey === key && now - Number(state.lastErrorAlertAt || 0) < cooldown) return false;
  // 红级：店铺级故障（登录风控、页面加载失败、页面结构异常等），不受免打扰时段影响，立即推送。
  await sendNotification(config, '【🔴 店铺故障】\n' + buildShopErrorMessage(errors).split('\n').join('\n\n'), {
    markdown: true,
    title: '【🔴 店铺故障】请及时处理',
  });
  state.lastErrorKey = key;
  state.lastErrorAlertAt = now;
  return true;
}

async function maybeSendShopRecoveries(config, items) {
  if (!items.length || !config.notifyOnError || !hasNotificationChannel(config)) return false;
  // 绿级：店铺恢复（默认不发送，仅当 notifyShopRecovery=true 时启用）。
  await sendNotification(config, '【🟢 恢复】\n' + buildShopRecoveryMessage(items).split('\n').join('\n\n'), {
    markdown: true,
    title: '【🟢 恢复】店铺恢复正常',
  });
  return true;
}

async function saveErrorScreenshot(page, shopKey) {
  if (!page) return;
  try {
    await ensureDirs();
    const safe = String(shopKey || 'shop').replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `error-${safe}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(LOG_DIR, name), fullPage: false });
    await log('info', `已保存错误截图：${path.join(LOG_DIR, name)}`);
  } catch (_) {}
}

async function detectShopCandidates(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const w = window.innerWidth || document.documentElement.clientWidth || 1600;
    const candidates = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > 190) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 35) continue;
      if (!/店|旗舰|官方|专营|专卖|企业|天猫|淘宝/.test(text)) continue;
      if (/商家后台|店铺管理|千牛|消息|客服|规则|卖家中心/.test(text) && text.length < 10) continue;
      candidates.push({ text, top: r.top, right: r.right, area: r.width * r.height });
    }
    return candidates
      .sort((a, b) => (b.right - a.right) || (a.top - b.top) || (a.area - b.area))
      .map((item) => item.text)
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .slice(0, 10);
  }).catch(() => []);
}

function isLoginPage(currentUrl, bodyText) {
  if (/login\.taobao\.com|login\.tmall\.com|login\.alibaba|passport|mini-login|signin|oauth|\/login/i.test(currentUrl)) return true;
  const hasLoginForm = /扫码登录|密码登录|短信登录|账户登录|手机验证登录|免费注册|欢迎登录|忘记密码|忘记账号|下载手机千牛|做生意上千牛/.test(bodyText);
  const hasBackendContent = /活动报名|报名记录|营销活动|出售中的宝贝|已卖出的宝贝|商品管理|交易管理|商家中心/.test(bodyText);
  return hasLoginForm && !hasBackendContent;
}

// ===== 登录风控自动弹窗（挂起店铺，不阻塞其他店铺） =====
// 密码登录被淘宝风控拦截（滑块/短信）时，自动拉起一个可见 Chrome 登录窗口等人工验证；
// 同一店铺 24 小时内只自动弹一次（节流标记），避免每轮失败都骚扰；人工登录成功后清除标记。
function loginPromptFlagPath(shop) {
  return path.join(DATA_DIR, `login-prompt-${String(shop.key || 'SHOP').toUpperCase()}.flag`);
}
async function promptManualLogin(shop) {
  const flagPath = loginPromptFlagPath(shop);
  if (fs.existsSync(flagPath)) {
    await log('warn', `[${shop.name}] 登录被风控拦截，但 24 小时内已弹过登录窗口，本轮挂起不重复弹（可手动执行 node shop-login.js ${shop.key} --auto 人工登录）。`);
    return;
  }
  try {
    fs.writeFileSync(flagPath, localNow() + '\n', 'utf8');
    // 用当前 node 的绝对路径（process.execPath）调 shop-login.js，不依赖系统 PATH，避免计划任务环境找不到 node。
    spawn('cmd.exe', ['/c', `"${process.execPath}" shop-login.js ${shop.key} --auto > login-${shop.key}.log 2>&1`], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    await log('alarm', `[${shop.name}] 登录被风控拦截：已自动打开可见 Chrome 登录窗口，请在窗口内完成滑块/短信验证（自动保存登录态）。本轮该店铺挂起，其他店铺继续检测。`);
  } catch (error) {
    await log('error', `[${shop.name}] 自动弹出登录窗口失败：${error.message || error}（可手动执行 node shop-login.js ${shop.key} --auto）`);
  }
}
async function clearLoginPromptFlag(shop) {
  const flagPath = loginPromptFlagPath(shop);
  if (fs.existsSync(flagPath)) {
    try { fs.unlinkSync(flagPath); } catch (_) {}
    await log('info', `[${shop.name}] 登录成功，已清除登录弹窗节流标记。`);
  }
}

async function runShopAttempt(config, shop) {
  let context;
  let page;
  const results = [];
  try {
    // 启用商品按 productId 运行时去重（保留首次出现的配置，不改 config.json），避免重复商品重复检测/重复计数。
    const seenProductIds = new Set();
    const products = shop.products.filter((item) => item.enabled && item.productId && (seenProductIds.has(String(item.productId)) ? false : (seenProductIds.add(String(item.productId)), true)));
    if (!products.length) {
      await log('warn', `[${shop.name}] 没有启用的白名单商品，跳过。`);
      return { results, error: null, detectedShopNames: [] };
    }
    if (config.browserMode === 'cdp') {
      // 连接用户自己打开的本机 Chrome：会话保存在真实浏览器里，监控只借用标签页，不关闭浏览器。
      // 多店铺时每个店铺一个独立 Chrome 窗口（独立用户目录 + 独立调试端口），互不串号。
      const debugPort = shop.chromeDebugPort || config.chromeDebugPort;
      await log('info', `[${shop.name}] 开始检测 ${products.length} 个商品，模式=连接本机 Chrome（调试端口 ${debugPort}）`);
      let browser = null;
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      } catch (connectError) {
        // 该店铺的监控 Chrome 窗口被关闭了：只重启这一个店铺的窗口（不动其他店铺），再连一次。
        const revived = await ensureShopChrome(config, shop, debugPort);
        if (revived) {
          try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
          } catch (_) {
            browser = null;
          }
        }
        if (!browser) {
          throw new Error(`无法连接本机 Chrome 调试端口 ${debugPort}，已尝试单独重启该店铺的监控 Chrome 仍未恢复。请手动执行 node start-chrome.js ${shop.key}（或双击“启动监控专用Chrome.bat”）打开窗口并保持打开。（${connectError.message || connectError}）`);
        }
      }
      // 复用用户 Chrome 的默认 context（包含登录态），不创建新 context
      context = browser.contexts()[0] || await browser.newContext();
      page = await context.newPage();
      // CDP 连接后短暂等待，确保连接稳定，避免竞态条件导致空结果
      await page.waitForTimeout(1500);
    } else {
      if (!fs.existsSync(shop.profileDir)) throw new Error(`登录 profile 不存在：${shop.profileDir}`);
      await log('info', `[${shop.name}] 开始检测 ${products.length} 个商品，profile=${shop.profileDir}`);
      // 内置模式每轮启动前清一次网页缓存（此时实例未运行，清理安全；登录态不受影响）。
      cleanProfileCache(shop.profileDir);
      context = await chromium.launchPersistentContext(shop.profileDir, {
        headless: config.headless,
        executablePath: config.chromeExecutablePath,
        viewport: { width: 1600, height: 1000 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      const pages = context.pages();
      page = pages[0] || await context.newPage();
      for (const extra of pages.slice(1)) { try { await extra.close(); } catch (_) {} }
    }
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);

    // 按活动页分组：商品可单独配置 activityUrl（一个店铺同时参加多个活动时，每个活动的报名记录页不同），
    // 未配置的商品使用店铺默认 activityUrl。同一活动页的商品一起检测，减少页面切换。
    const groups = new Map();
    for (const product of products) {
      const url = String(product.activityUrl || '').trim() || shop.activityUrl;
      if (!groups.has(url)) groups.set(url, []);
      groups.get(url).push(product);
    }
    if (groups.size > 1) {
      await log('info', `[${shop.name}] 检测到 ${groups.size} 个活动页，将逐页检测。`);
    }

    let detectedShopNames = [];
    let shopVerified = false;

    // 直接密码登录：本环境实测登录态复用必然失效（淘宝对无头新会话强制重登，即使 cookie 已写回 profile），
    // 每轮直接用账号密码登录最可靠；密码登录被风控拦截时自动弹可见窗口挂起等人工验证（不阻塞其他店铺）。
    if (shop.account && shop.password) {
      await log('info', `[${shop.name}] 正在用账号密码登录…`);
      const relogin = await attemptPasswordLogin(page, shop, log, {
        challengeWaitSeconds: config.reloginChallengeWaitSeconds,
        manualAssist: config.browserMode === 'cdp' || !config.headless,
      });
      if (!relogin.ok) {
        await promptManualLogin(shop);
        throw new Error(`直接登录失败：${relogin.reason}。请检查账号密码是否正确，或人工完成验证（node shop-login.js ${shop.key}）。`);
      }
      await log('info', `[${shop.name}] 自动登录成功，开始检测。`);
      await clearLoginPromptFlag(shop);
    }

    for (const [groupUrl, groupProducts] of groups) {
      await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForTimeout(6000);

      let currentUrl = page.url();
      const title = await page.title();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 30000);
      if (isLoginPage(currentUrl, bodyText)) {
        // 已在上面直接登录过，这里仍被重定向说明触发风控/会话被作废：弹窗挂起，不再二次登录。
        await promptManualLogin(shop);
        throw new Error(`登录状态已失效，当前页面：${currentUrl}。登录后访问活动页仍被重定向（可能触发滑块/短信风控），请人工完成验证。（cdp 模式：在监控专用 Chrome 里登录；内置模式：node shop-login.js ${shop.key}）。`);
      }

      if (!shopVerified) {
        detectedShopNames = await detectShopCandidates(page);
        if (shop.verifyShopName && shop.name) {
          const expected = compactText(shop.name);
          const bodyMatched = compactText(bodyText).includes(expected);
          const candidateMatched = detectedShopNames.some((name) => compactText(name).includes(expected) || expected.includes(compactText(name)));
          if (!bodyMatched && !candidateMatched) {
            throw new Error(`店铺名称校验失败。配置为“${shop.name}”，页面候选为：${detectedShopNames.join(' / ') || '未识别到'}。为避免串店，已跳过本店铺。`);
          }
        }
        shopVerified = true;
      }

      // 切换到「异常」tab，翻页抓全量异常商品 ID，再与本页监控商品本地比对。
      // 带整轮重试：翻页失败或数量对不上会自动重扫，异常 ID 跨轮合并锁定。
      const scan = await scanAnomalyTabWithRetry(page);
      if (scan.error && scan.anomalyIds.size === 0) {
        throw new Error(scan.error);
      }
      await log('info', `[${shop.name}] 进入活动页：${title}，本页监控 ${groupProducts.length} 个；活动异常名单共 ${scan.anomalyIds.size} 个${scan.declaredCount != null ? `（页面标注 ${scan.declaredCount}）` : ''}。`);

      for (const product of groupProducts) {
        const pid = String(product.productId || '').trim();
        const hit = scan.anomalyIds.has(pid);
        const result = {
          ...product,
          productId: pid,
          shopKey: shop.key,
          shopName: shop.name,
          anomalies: hit ? ['anomaly'] : [],
          isAnomaly: hit,
          isOffline: false,
          isDraft: false,
          isStatusAbnormal: hit,
          matchedRows: hit ? 1 : 0,
          statusText: hit ? '商品在活动「异常」名单中，请查看原因并处理' : '未在异常名单中',
          activityTitle: product.title || product.activityTitle || '',
          latestOfflineTime: '',
          latestSuccessTime: '',
          currentPrice: '',
          currentStock: '',
          // 翻页部分失败（scan.error）只在日志提醒（见 scanAnomalyTab 数量比对），不污染商品结果，
          // 否则前端会把本店全部商品误标成异常红色。真正的全量抓取失败会走上方 throw → 店铺异常。
          error: '',
          warnings: [],
          rowPreview: [],
        };
        results.push(result);
        await log(hit ? 'alarm' : 'info', `[${shop.name}] ${pid}：${result.statusText}`, {
          anomalies: hit ? 'anomaly' : '',
          error: scan.error || '',
        });
      }
    }
    return { results, error: null, detectedShopNames, transientError: false };
  } catch (error) {
    await log('error', `[${shop.name}] ${error.stack || error.message || String(error)}`);
    await saveErrorScreenshot(page, shop.key);
    // 「异常 tab 一个都没渲染出来」（现有：为空）说明活动页没加载出来（只渲染了后台外壳/被跳转），
    // 属偶发瞬时问题，归入 transientError 让 runShop 自动重开浏览器重试；有 tab 但没有[异常]tab 则不重试
    // （那可能是页面结构变化，重试无意义，避免死循环）。
    const transient = isTransientBrowserError(error) || /页面未找到「异常」tab（现有：）/.test(error.message || '') || /商品列表未渲染/.test(error.message || '');
    return { results, error: error.message || String(error), detectedShopNames: [], transientError: transient };
  } finally {
    if (config.browserMode === 'cdp') {
      // 只关闭监控自己打开的标签页，保留用户的 Chrome 窗口和登录态。
      if (page) { try { await page.close(); } catch (_) {} }
    } else if (context) {
      try { await context.close(); } catch (_) {}
    }
  }
}

async function runShop(config, shop) {
  const maxAttempts = Math.max(2, Math.min(3, Number(config.transientRetryAttempts) || 2));
  const delayMs = Math.max(1, Math.min(30, Number(config.transientRetryDelaySeconds) || 3)) * 1000;
  let lastOutcome = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await runShopAttempt(config, shop);
    outcome.attemptsUsed = attempt;
    // 空结果视为异常（可能是 context 无效导致的假成功），自动重试
    const emptyResult = !outcome.error && (!outcome.results || outcome.results.length === 0);
    if (emptyResult && attempt < maxAttempts) {
      await log('warn', `[${shop.name}] 检测返回空结果（可能是浏览器上下文异常），第 ${attempt} 次尝试；${Math.round(delayMs / 1000)} 秒后自动重试。`);
      lastOutcome = outcome;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!outcome.error) {
      outcome.autoRetryRecovered = attempt > 1;
      if (attempt > 1) await log('info', `[${shop.name}] 浏览器瞬时异常已在第 ${attempt} 次尝试自动恢复，本轮不发送异常通知。`);
      return outcome;
    }
    lastOutcome = outcome;
    if (!outcome.transientError || attempt >= maxAttempts) return outcome;
    await log('warn', `[${shop.name}] 检测页面被关闭或连接中断，第 ${attempt} 次尝试失败；${Math.round(delayMs / 1000)} 秒后自动重开浏览器重试。`, { error: outcome.error });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return lastOutcome || { results: [], error: '未知店铺检测错误', detectedShopNames: [], attemptsUsed: maxAttempts };
}

// 商品级报警去重：异常期间按 anomalyRepeatMinutes 重复提醒；恢复后自动通知。
// partialKey 非空表示只检测了单个店铺：其他店铺的报警状态必须原样保留，只更新该店铺的商品。
function diffProductAlerts(config, allResults, state, partialKey) {
  const productAlerts = state.productAlerts && typeof state.productAlerts === 'object' ? state.productAlerts : {};
  const now = Date.now();
  const repeatMs = config.anomalyRepeatMinutes * 60 * 1000;
  const toAlert = [];
  const toRecover = [];
  // 单店铺检测时先继承其他店铺的旧报警状态，再覆盖本店铺部分；全量检测时从零重建。
  const nextAlerts = {};
  if (partialKey) {
    for (const [key, value] of Object.entries(productAlerts)) {
      if (!key.startsWith(`${partialKey}:`)) nextAlerts[key] = value;
    }
  }

  for (const item of allResults) {
    if (!item || item.error && !item.isAnomaly) continue;
    const key = `${item.shopKey}:${item.productId}`;
    if (item.isAnomaly) {
      const signature = (item.anomalies || []).slice().sort().join(',');
      const previous = productAlerts[key];
      const shouldAlert = !previous
        || previous.signature !== signature
        || repeatMs === 0
        || now - Number(previous.lastAlertAt || 0) >= repeatMs;
      nextAlerts[key] = {
        signature,
        firstAlertAt: previous ? Number(previous.firstAlertAt || now) : now,
        lastAlertAt: shouldAlert ? now : Number(previous.lastAlertAt || now),
      };
      if (shouldAlert) toAlert.push(item);
    } else if (productAlerts[key]) {
      toRecover.push({ ...item, previousAnomalies: String(productAlerts[key].signature || '').split(',').filter(Boolean) });
    }
  }

  state.productAlerts = nextAlerts;
  return { toAlert, toRecover };
}

// 给异步操作加超时：页面/浏览器操作偶尔永远不返回，没有兜底会把整轮检测卡死。
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超过 ${Math.round(ms / 60000)} 分钟未返回，本轮已跳过该店铺`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// onlyShopKey 非空时只检测该店铺（网页管理端「检测此店铺」用），结果与上一轮全量结果合并，不清空其他店铺。
async function runCycle(onlyShopKey) {
  if (running) { await log('warn', '上一次检测仍在运行，本次跳过。'); return; }
  running = true;
  let config;
  try {
    config = await loadConfig();
    let shops = config.shops.filter((shop) => shop.enabled);
    if (onlyShopKey) {
      shops = shops.filter((shop) => shop.key === onlyShopKey);
      if (!shops.length) throw new Error(`店铺 ${onlyShopKey} 不存在或已停用，无法单独检测。`);
    } else if (!shops.length) {
      throw new Error('没有启用的店铺，请运行 node configure.js 添加店铺。');
    }

    const state = await readState();
    state.shopHealth = state.shopHealth && typeof state.shopHealth === 'object' ? state.shopHealth : {};
    await log('info', onlyShopKey
      ? `开始单店铺检测：${shops[0].name}（${onlyShopKey}）。`
      : `开始多店铺检测：${shops.length} 个店铺。瞬时浏览器异常最多自动尝试 ${config.transientRetryAttempts} 次。`);
    const allResults = [];
    const shopErrors = [];
    const shopSummaries = [];
    const shopRecoveryItems = [];

    // 单店铺最长耗时兜底：超过即放弃该店铺本轮检测（页面卡死时防止整轮永久挂起），保证整轮一定能收尾、时间戳一定会更新。
    const shopTimeoutMs = Math.max(5, Number(config.shopTimeoutMinutes) || 12) * 60 * 1000;
    for (const shop of shops) {
      let outcome;
      try {
        outcome = await withTimeout(runShop(config, shop), shopTimeoutMs, `[${shop.name}] 店铺检测`);
      } catch (shopError) {
        outcome = { results: [], error: shopError.message || String(shopError), detectedShopNames: [], attemptsUsed: 1 };
      }
      const nowText = localNow();
      const previousHealth = state.shopHealth[shop.key] || {};
      const health = { ...previousHealth, lastAttemptTime: nowText };
      allResults.push(...outcome.results);

      if (outcome.error) {
        health.currentStatus = 'error';
        health.lastErrorTime = nowText;
        health.lastError = outcome.error;
        health.consecutiveFailedCycles = Number(previousHealth.consecutiveFailedCycles || 0) + 1;
        health.lastAttemptsUsed = Number(outcome.attemptsUsed || 1);
        health.lastErrorWasTransient = Boolean(outcome.transientError);
        shopErrors.push({
          shopKey: shop.key,
          shopName: shop.name,
          error: outcome.error,
          transientError: Boolean(outcome.transientError),
          attemptsUsed: Number(outcome.attemptsUsed || 1),
          lastSuccessTime: previousHealth.lastSuccessTime || '',
        });
      } else {
        if (previousHealth.currentStatus === 'error' && previousHealth.errorAlerted) {
          shopRecoveryItems.push({
            shopKey: shop.key,
            shopName: shop.name,
            lastErrorTime: previousHealth.lastErrorTime || '',
            lastError: previousHealth.lastError || '',
            recoveredAt: nowText,
          });
          health.lastRecoveredTime = nowText;
        }
        health.currentStatus = 'normal';
        health.lastSuccessTime = nowText;
        health.consecutiveFailedCycles = 0;
        health.lastAttemptsUsed = Number(outcome.attemptsUsed || 1);
        health.lastAutoRetryRecovered = Boolean(outcome.autoRetryRecovered);
        health.errorAlerted = false;
      }
      state.shopHealth[shop.key] = health;

      shopSummaries.push({
        key: shop.key,
        name: shop.name,
        productCount: shop.products.filter((item) => item.enabled && item.productId).length,
        resultCount: outcome.results.length,
        error: outcome.error || '',
        detectedShopNames: outcome.detectedShopNames || [],
        attemptsUsed: Number(outcome.attemptsUsed || 1),
        autoRetryRecovered: Boolean(outcome.autoRetryRecovered),
        currentStatus: health.currentStatus,
        lastSuccessTime: health.lastSuccessTime || '',
        lastErrorTime: health.lastErrorTime || '',
        lastError: health.lastError || '',
        lastRecoveredTime: health.lastRecoveredTime || '',
        consecutiveFailedCycles: Number(health.consecutiveFailedCycles || 0),
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // 记住每个商品最近一次识别到的活动名称/商品名称；商品消失时回填，避免报警里“活动名称：未填写”。
    state.productInfo = state.productInfo && typeof state.productInfo === 'object' ? state.productInfo : {};
    for (const item of allResults) {
      if (!item || !item.productId) continue;
      const infoKey = `${item.shopKey}:${item.productId}`;
      const info = state.productInfo[infoKey] || {};
      if (!item.activityTitle && info.activityTitle) item.activityTitle = info.activityTitle;
      if (!item.productName && info.productName) item.productName = info.productName;
      if (item.activityTitle) info.activityTitle = item.activityTitle;
      if (item.productName) info.productName = item.productName;
      info.lastSeenAt = localNow();
      state.productInfo[infoKey] = info;
    }

    const { toAlert, toRecover } = diffProductAlerts(config, allResults, state, onlyShopKey || '');

    if (toAlert.length) {
      const quiet = isInQuietHours(config);
      if (quiet) {
        // 免打扰时段：黄级商品异常不推钉钉（检测与记录照常，后台可查），红级店铺故障不受影响。
        await log('warn', `检测到 ${toAlert.length} 个商品活动异常，当前处于免打扰时段（${String(config.quietHours || '').trim()}），未推送钉钉，检测与记录照常。`);
      } else if (hasNotificationChannel(config)) {
        // markdown 模式发送（负责人行标红）；钉钉 markdown 单换行不生效，统一转成双换行。
        // @ 异常商品的负责人：同一人多个商品只 @ 一次；钉钉的 @ 需用绑定的手机号（ownerPhones 映射）。
        const ownersToAt = [...new Set(toAlert.map((item) => String(item.owner || '').trim()).filter(Boolean))];
        const atPhones = [...new Set(ownersToAt.map((name) => config.ownerPhones[name]).filter(Boolean))];
        const unmapped = ownersToAt.filter((name) => !config.ownerPhones[name]);
        // 黄级：商品级异常，标题带级别标记。
        const markdownText = '【🟡 商品异常】\n' + buildAnomalyMessage(toAlert);
        // 钉钉发送失败/超时绝不能中断检测轮（否则检测结果和时间戳写不进去，时间戳会“冻结”），
        // 所以整个发送块包 try/catch，失败只记日志，流程继续走。
        try {
          const channels = await sendNotification(config, markdownText.split('\n').join('\n\n'), {
            markdown: true,
            title: `【🟡 商品异常】${toAlert.length} 个商品`,
          });
          // 钉钉平台限制：markdown 消息里的 @ 只显示蓝字，不触发“有人@我”的强提醒。
          // 必须再发一条 text 消息（正文含 @手机号 + atMobiles 带号码）才会真正 @ 到负责人。
          if (ownersToAt.length) {
            // 钉钉会把 @手机号 渲染成蓝色的对方姓名，无需再括号备注名字（备注反而显得冗余）；
            // 只有没配手机号的负责人才退化为 @名字 纯文本提示。
            const mentionParts = ownersToAt.map((name) => (config.ownerPhones[name] ? `@${config.ownerPhones[name]}` : `@${name}`));
            await sendNotification(config, `【活动异常提醒】请负责人处理：${mentionParts.join(' ')}`, { atMobiles: atPhones });
          }
          await log('alarm', `${channels.join('、')}报警发送成功：${toAlert.length} 个商品活动异常。${alertDetailLog(toAlert)}`);
        } catch (notifyError) {
          await log('error', `钉钉报警发送失败（检测结果不受影响，继续保存）：${notifyError.message || notifyError}`);
        }
        if (unmapped.length) await log('warn', `以下负责人未配置手机号映射，无法真正 @ 到本人（请在网页管理或 config.json 的 ownerPhones 里补充）：${unmapped.join('、')}`);
      } else {
        await log('warn', `检测到 ${toAlert.length} 个商品活动异常，但未配置钉钉机器人。`);
      }
    }

    // 商品恢复通知默认不发送钉钉（用户要求：只有异常状态才提醒，恢复无需通知），仅记录日志；
    // 如需恢复该通知，在 config.json 设置 "notifyProductRecovery": true。
    if (toRecover.length) {
      await log('info', `商品已恢复正常（按配置不发送恢复通知）：${toRecover.map((item) => `${item.shopName}/${item.productId}`).join('、')}`);
      if (config.notifyProductRecovery === true && hasNotificationChannel(config)) {
        try {
          // 绿级：商品恢复（默认不发送，仅当 notifyProductRecovery=true 时启用）。
          await sendNotification(config, '【🟢 恢复】\n' + buildProductRecoveryMessage(toRecover).split('\n').join('\n\n'), {
            markdown: true,
            title: '【🟢 恢复】商品恢复正常',
          });
          await log('info', `商品恢复通知已发送：${toRecover.map((item) => `${item.shopName}/${item.productId}`).join('、')}`);
        } catch (notifyError) {
          await log('error', `商品恢复通知发送失败（不影响检测流程）：${notifyError.message || notifyError}`);
        }
      }
    }

    const errorSent = await maybeSendErrors(config, shopErrors, state).catch(async (notifyError) => {
      await log('error', `店铺异常通知发送失败（不影响检测流程）：${notifyError.message || notifyError}`);
      return false;
    });
    if (errorSent) {
      for (const item of shopErrors) {
        if (state.shopHealth[item.shopKey]) state.shopHealth[item.shopKey].errorAlerted = true;
      }
    }
    if (shopRecoveryItems.length) {
      // 店铺异常恢复通知默认不发送（用户反馈无实际意义），仅记录日志；
      // 如需恢复该通知，在 config.json 设置 "notifyShopRecovery": true。
      if (config.notifyShopRecovery === true) {
        try {
          await maybeSendShopRecoveries(config, shopRecoveryItems);
          await log('info', `店铺异常恢复通知已发送：${shopRecoveryItems.map((item) => item.shopName).join('、')}`);
        } catch (notifyError) {
          await log('error', `店铺恢复通知发送失败（不影响检测流程）：${notifyError.message || notifyError}`);
        }
      } else {
        await log('info', `店铺已恢复正常（按配置不发送恢复通知）：${shopRecoveryItems.map((item) => item.shopName).join('、')}`);
      }
    }

    state.lastSuccessAt = Date.now();
    state.lastSuccessText = localNow();
    if (!shopErrors.length) state.lastErrorKey = '';
    await writeState(state);
    await ensureDirs();
    if (onlyShopKey) {
      // 单店铺检测：与上一轮全量结果合并，只替换本店铺的汇总和商品结果，其他店铺数据保留。
      let mergedShops = [];
      let mergedResults = [];
      try {
        const prev = JSON.parse(await fsp.readFile(RESULTS_PATH, 'utf8'));
        mergedShops = (prev.shops || []).filter((item) => item.key !== onlyShopKey);
        mergedResults = (prev.results || []).filter((item) => item.shopKey !== onlyShopKey);
      } catch (_) {}
      mergedShops.push(...shopSummaries);
      mergedResults.push(...allResults);
      await fsp.writeFile(RESULTS_PATH, `${JSON.stringify({ time: localNow(), version: MONITOR_VERSION, shops: mergedShops, results: mergedResults }, null, 2)}\n`, 'utf8');
    } else {
      await fsp.writeFile(RESULTS_PATH, `${JSON.stringify({ time: localNow(), shops: shopSummaries, results: allResults }, null, 2)}\n`, 'utf8');
    }

    const anomalyTotal = allResults.filter((item) => item && item.isAnomaly).length;
    const recognitionErrors = allResults.filter((item) => item && item.error && !item.isAnomaly);
    await log('info', `多店铺检测完成：店铺 ${shops.length} 个，结果 ${allResults.length} 条，活动异常 ${anomalyTotal} 个（本轮新报警 ${toAlert.length} 个，恢复 ${toRecover.length} 个），店铺确认异常 ${shopErrors.length} 个，识别异常 ${recognitionErrors.length} 个。`);
    // 记录本轮检测历史（供管理后台「检测趋势」看板），只保留最近 500 轮，单轮写入失败不影响本轮。
    try {
      const HISTORY_PATH = path.join(DATA_DIR, 'detect-history.json');
      let history = [];
      try { history = JSON.parse(await fsp.readFile(HISTORY_PATH, 'utf8')); } catch (_) {}
      if (!Array.isArray(history)) history = [];
      history.push({
        time: localNow(),
        shops: shops.length,
        results: allResults.length,
        anomalies: anomalyTotal,
        alerts: toAlert.length,
        recoveries: toRecover.length,
        errors: shopErrors.length,
        shopErrorDetails: shopErrors.slice(0, 10).map((e) => `${e.shopName}:${e.error}`),
      });
      if (history.length > 500) history.splice(0, history.length - 500);
      await fsp.writeFile(HISTORY_PATH, JSON.stringify(history), 'utf8');
    } catch (_) {}
  } catch (error) {
    await log('error', error.stack || error.message || String(error));
    if (config) {
      const state = await readState();
      await maybeSendErrors(config, [{ shopKey: 'global', shopName: '全局任务', error: error.message || String(error), attemptsUsed: 1 }], state).catch(() => {});
      await writeState(state).catch(() => {});
    }
  } finally {
    running = false;
  }
}

async function daemon() {
  await ensureDirs();
  // 支持 --delay=N：启动后先等待 N 分钟再跑第一轮（凌晨自动重启脚本用，避免重启后立即触发登录检测）。
  const delayArg = process.argv.find((arg) => arg.startsWith('--delay='));
  const delayMinutes = delayArg ? Math.max(0, Number(delayArg.slice('--delay='.length)) || 0) : 0;
  const startupConfig = await loadConfig().catch(() => ({}));
  await log('info', `淘宝/天猫多店铺活动异常监控服务已启动，代码版本 ${MONITOR_VERSION}（通知渠道：${notificationChannelLabel(startupConfig)}；异常类型：活动下线/被清退、商品从活动中消失、报名未完成(草稿/待完善)、活动价与库存异常；商品级报警去重；只有异常状态才发钉钉，恢复不通知）。`);
  if (delayMinutes > 0) {
    await log('info', `检测前等待 ${delayMinutes} 分钟（--delay=${delayMinutes}）。`);
    await new Promise((resolve) => setTimeout(resolve, delayMinutes * 60 * 1000));
  }
  let pauseLogged = false;
  let firstRecoveryCheck = true;
  while (!stopRequested) {
    // 网页管理端点了「停止检测」：跳过自动巡检，每 5 秒检查一次是否恢复。
    if (isMonitorPaused()) {
      if (!pauseLogged) {
        await log('info', '监控已被网页管理端暂停（存在 data/monitor-paused.flag）。自动检测已停止，点「恢复检测」后继续。');
        pauseLogged = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    pauseLogged = false;
    if (firstRecoveryCheck) {
      // 刚被守护脚本拉起时，恢复标记可能还在写入（VBS 先拉起 admin-server 再拉起 monitor，
      // 各等 3 秒确认存活才写标记）。首次检查前等 45 秒，让同轮拉起的多个服务标记一次性被读到，
      // 合并成一条「服务自动恢复」通知，避免漏报或拆成两条重复打扰。
      firstRecoveryCheck = false;
      await new Promise((resolve) => setTimeout(resolve, 45000));
    }
    await cleanupStorageOncePerHour();
    await checkRecoveredFlags();
    const config = await loadConfig().catch(() => ({ intervalMinutes: 30 }));
    await runCycle();
    const waitMs = Math.max(Number(config.intervalMinutes) || 30, 1) * 60 * 1000;
    await log('info', `下次检测将在 ${Math.round(waitMs / 60000)} 分钟后执行。`);
    let elapsed = 0;
    while (!stopRequested && elapsed < waitMs && !isMonitorPaused()) {
      const step = Math.min(1000, waitMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, step));
      elapsed += step;
    }
  }
  await log('info', '淘宝/天猫多店铺活动异常监控服务已停止。');
}

process.on('SIGTERM', () => { stopRequested = true; });
process.on('SIGINT', () => { stopRequested = true; });

// 支持 node monitor.js --once --shop=<店铺编号> 只检测单个店铺（网页管理端「检测此店铺」按钮用）。
if (process.argv.includes('--once')) {
  const shopArg = process.argv.find((arg) => arg.startsWith('--shop='));
  const onlyShopKey = shopArg ? String(shopArg.slice('--shop='.length)).trim() : '';
  runCycle(onlyShopKey || undefined).then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  daemon().catch(async (error) => { await log('error', error.stack || String(error)); process.exit(1); });
}
