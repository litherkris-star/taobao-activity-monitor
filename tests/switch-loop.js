'use strict';
// 回归测试 C：点击「异常」tab 后列表还没切换、先渲染出来的是「全部商品」第一页时，
// 扫描是否会把它当成异常名单抓走（用户可见症状：日志「抓到 11 个，页面标注 1 个」）。
//
// 用法（在仓库根目录）：node tests/switch-loop.js
//   退出码 0 = 抓到的 ID 数与页面标注一致（列表切换判定可靠）
//   退出码 1 = 抓到的是「全部商品」列表（数量与标注不符）
//
// 现场（logs/monitor.log）：
//   116519 英港「数量不符：抓到 11 个，页面标注 1 个」
//   116567 创庭「扫描无效：…抓到 79 个」
//   118336 收纳达人「…抓到 314 个」
// 截图证据：底部状态条「异常(1)」，而代码抓到的 10 行是「全部商品」第一页。
//
// 这里用一个假 DOM 驱动真实的 scanAnomalyTab（不 mock 被测函数本身），
// 复现的顺序就是真机上的顺序：点击 → tab 立刻 active → 旧列表的行晚到。
const fs = require('fs');
const path = require('path');
const os = require('os');

const MONITOR = path.join(__dirname, '..', 'monitor.js');
const src = fs.readFileSync(MONITOR, 'utf8').replace(/^\uFEFF/, '');
const lines = src.split(/\r?\n/);
const cut = lines.findIndex((l) => l.startsWith('// 支持 node monitor.js --once'));
const body = lines.slice(0, cut > 0 ? cut : lines.length).join('\n');

const SANDBOX = path.join(os.tmpdir(), 'taobao-diag-sandbox');
fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });

const notifierStub = {
  sendNotification: async () => ({ ok: true }),
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
  body + '\nreturn { scanAnomalyTab };'
);
const api = factory(fakeRequire, SANDBOX, { exports: {} }, {}, process, MONITOR, console);

// ---------- 假 DOM ----------
// 时间线（与真机一致）：
//   t0  点击「异常」tab，tab 立刻变成 active，但列表里还没有行（beforeSig === ''）
//   t1  旧列表（全部商品，11 行）先渲染出来 —— 这就是被误抓的那一页
//   t2  真正切到异常名单，只剩 1 行（页面标注的异常(1)）
const STALE = Array.from({ length: 11 }, (_, i) => String(6210000000000 + i));
const TRUE_IDS = ['6210000000005'];

function makeDom() {
  const state = { clicked: false, polls: 0, rows: [] };
  const mkRow = (id) => ({
    innerText: `商品名 ${id}\n商品ID ${id}`,
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
    querySelector: () => null,
  });
  const tab = {
    innerText: '异常(1)',
    className: '',
    getAttribute: (n) => (n === 'aria-selected' ? (state.clicked ? 'true' : 'false') : null),
    setAttribute: () => {},
    getBoundingClientRect: () => ({ width: 80, height: 30 }),
    querySelector: () => null,
    click: () => { state.clicked = true; },
  };
  const doc = {
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes('next-table-row')) return state.rows.map(mkRow);
      if (s.includes('pagination')) return [];
      if (s.includes('tab')) return [tab];
      return [];
    },
  };
  return { state, doc, tick() {
    state.polls += 1;
    if (!state.clicked) { state.rows = []; return; }
    if (state.polls <= 1) state.rows = [];              // 点击后列表还没刷新出来
    else if (state.polls <= 5) state.rows = STALE.slice(); // 旧列表先到：全部商品 11 行
    else state.rows = TRUE_IDS.slice();                 // 真正切到异常名单：1 行
  } };
}

async function runOnce(preRendered) {
  const dom = makeDom();
  // 对照组：点击前列表已经渲染出来（点击前签名非空），此时旧行不会晚到
  if (preRendered) dom.state.rows = STALE.slice();
  global.document = dom.doc;
  const page = {
    // 每次等待推进一帧；不真正睡眠，保证循环是秒级且确定的
    waitForTimeout: async () => { dom.tick(); },
    reload: async () => { dom.state.polls = 0; },
    click: async () => { dom.state.clicked = true; },
    evaluate: async (fn) => fn(),
  };
  const scan = await api.scanAnomalyTab(page);
  delete global.document;
  return { scan, polls: dom.state.polls };
}

function report(label, expect, { scan }) {
  const got = [...(scan.anomalyIds || [])];
  const declared = scan.declaredCount;
  const ok = declared != null && got.length === declared;
  console.log(`\n── ${label}`);
  console.log('   页面标注异常数:', declared, '｜实际抓到:', got.length, got.slice(0, 3).join('、') + (got.length > 3 ? '…' : ''));
  console.log('   scan.error:', scan.error || '(空)');
  console.log(ok ? '   结果: PASS 抓到的是异常名单本身' : `   结果: FAIL 抓到 ${got.length} 个，页面标注 ${declared} 个 —— 抓到的是「全部商品」第一页`);
  return ok === expect;
}

(async () => {
  // C1 现场复现：点击前列表还没渲染（beforeSig === ''），旧列表晚到
  const c1ok = report('C1 点击前列表未渲染（故障现场）', true, await runOnce(false));
  // C2 对照组：点击前列表已渲染，签名能识别切换 —— 这一条应该一直绿
  const c2ok = report('C2 对照组：点击前列表已渲染', true, await runOnce(true));
  const ok = c1ok && c2ok;
  console.log(ok ? '\n结论: PASS' : '\n结论: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('跑挂:', e && e.stack || e);
  process.exit(2);
});
