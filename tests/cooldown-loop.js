'use strict';
// 回归测试 A：店铺故障报警的冷却是否生效
//
// 用法（在仓库根目录）：node tests/cooldown-loop.js
//   退出码 0 = 冷却生效（180 分钟内同类故障只推一次）
//   退出码 1 = 冷却被击穿，同一故障在冷却期内被重复推送
//
// 背景：店铺故障提醒原本用「店铺:完整错误文本」做去重 key，而错误文本里带商品 ID 与
// 抓取数量，每轮都会变 → key 永不相等 → errorAlertCooldownMinutes 形同虚设；
// 再加上「只要有一轮没有店铺故障就把 key 清空」，抖动店等于每轮都能推一次。
// 该脚本直接加载 monitor.js 的真实函数（截掉 CLI 分发段），用一个假的 notifier 记录推送次数。
const fs = require('fs');
const path = require('path');
const os = require('os');

const MONITOR = path.join(__dirname, '..', 'monitor.js');
const src = fs.readFileSync(MONITOR, 'utf8').replace(/^\uFEFF/, '');
const lines = src.split(/\r?\n/);
const cut = lines.findIndex((l) => l.startsWith('// 支持 node monitor.js --once'));
const body = lines.slice(0, cut > 0 ? cut : lines.length).join('\n');

// 日志写到临时目录，绝不污染生产 logs/monitor.log
const SANDBOX = path.join(os.tmpdir(), 'taobao-diag-sandbox');
fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });

const sent = [];
const notifierStub = {
  sendNotification: async (config, text, opts) => {
    sent.push({ title: (opts && opts.title) || '', first: String(text).split('\n')[0] });
    return { ok: true };
  },
  hasNotificationChannel: () => true,
  notificationChannelLabel: () => 'stub',
  normalizeNotificationConfig: (c) => c,
};
const fakeRequire = (id) => {
  if (id === 'playwright') return { chromium: {} };
  if (id === './notifier') return notifierStub;
  if (id === './password-login') return { attemptPasswordLogin: async () => ({ ok: false }) };
  return require(id);
};
const factory = new Function(
  'require', '__dirname', 'module', 'exports', 'process', '__filename', 'console',
  body + '\nreturn { maybeSendErrors, classifyShopError };'
);
const api = factory(fakeRequire, SANDBOX, { exports: {} }, {}, process, 'monitor.js', console);

const config = {
  notifyOnError: true,
  errorAlertCooldownMinutes: 180,
  notification: { type: 'dingtalk', webhook: 'https://example.invalid/stub' },
};

// 真实日志/state.json 里出现过的错误文本形态（商品 ID 与抓取数量每轮都变）
const mkErr = (counts, ids) => ([
  { shopKey: 'YG', error: `数量不符：抓到 ${counts} 个，页面标注 1 个；样例 ${ids.slice(0, 3).join(',')}...` },
  { shopKey: 'LPZY', error: `扫描无效：页面未标注异常数量却抓到 ${counts} 个；样例 ${ids.slice(3, 6).join(',')}...` },
]);

const cases = [
  {
    name: 'A1 同类故障 3 轮（错误文本随商品ID/数量变化，真实形态）',
    rounds: [
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
      mkErr(10, ['7811', '7812', '7813', '7814', '7815', '7820']),
      mkErr(103, ['9001', '9002', '9003', '9004', '9005', '9006']),
    ],
    clearOnSuccess: false,
  },
  {
    name: 'A2 对照：错误文本完全一致（证明差异来自文本 churn）',
    rounds: [
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
    ],
    clearOnSuccess: false,
  },
  {
    name: 'A3 失败-成功-失败（成功轮不得清空冷却账目）',
    rounds: [
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
      [],
      mkErr(11, ['7811', '7812', '7813', '7814', '7815', '7816']),
    ],
    clearOnSuccess: true,
  },
];

(async () => {
  let failed = 0;
  for (const c of cases) {
    sent.length = 0;
    const state = {};
    const perRound = [];
    for (const errs of c.rounds) {
      const before = sent.length;
      await api.maybeSendErrors(config, errs, state);
      perRound.push(sent.length - before);
      // 复刻「本轮无店铺故障」这条路径：期望它**不**清空冷却账目
      if (c.clearOnSuccess && errs.length === 0) state.lastErrorKey = state.lastErrorKey || '';
    }
    const total = sent.length;
    const ok = total <= 1;
    if (!ok) failed += 1;
    console.log(`${ok ? 'GREEN' : 'RED  '} ${c.name}`);
    console.log(`      每轮发送: [${perRound.join(', ')}]  合计 ${total} 次  |  期望合计 1 次（180 分钟内同类故障只推一次）`);
  }
  console.log(`\n结论: ${failed === 0 ? 'PASS 冷却生效' : `FAIL 有 ${failed} 个场景在冷却期内重复推送`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
