'use strict';
// 回归测试 C：点击「异常」tab 后列表还没切换、先渲染出来的是「全部商品」第一页时，
// 扫描是否会把它当成异常名单抓走（用户可见症状：日志「抓到 11 个，页面标注 1 个」）。
//
// 用法（在仓库根目录）：node tests/switch-loop.js
//   退出码 0 = 三条场景全部符合预期
//   退出码 1 = 有场景不符合（抓到全部商品列表 / 把标注滞后误判成扫描无效）
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

const ids = (n, base) => Array.from({ length: n }, (_, i) => String(base + i));

// ---------- 假 DOM ----------
// 时间线（与真机一致）：点击「异常」tab → tab 立刻 active，列表还没行 →
// 旧列表（全部商品）先渲染出来 → 真正切到异常名单。
function makeDom(spec) {
  const state = { clicked: false, polls: 0, rows: [] };
  const mkRow = (id) => ({
    innerText: `商品名 ${id}\n商品ID ${id}`,
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
    querySelector: () => null,
  });
  const tab = {
    innerText: `异常(${spec.declared})`,
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
  return {
    state, doc,
    tick() {
      state.polls += 1;
      if (!state.clicked) { return; }
      if (state.polls <= spec.staleFrom - 1) state.rows = [];            // 点击后列表还没刷新出来
      else if (state.polls <= spec.trueFrom - 1) state.rows = spec.stale; // 旧列表先到（全部商品）
      else state.rows = spec.trueRows;                                    // 真正切到异常名单
    },
  };
}

async function runOnce(spec) {
  const dom = makeDom(spec);
  if (spec.preRendered) { dom.state.rows = spec.stale; dom.state.polls = 1; }
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
  return scan;
}

function report(label, expect, scan) {
  const got = [...(scan.anomalyIds || [])];
  const invalid = /^扫描无效/.test(scan.error || '');
  const sizeOk = expect.size == null || got.length === expect.size;
  const invalidOk = expect.noInvalidError ? !invalid : true;
  const ok = sizeOk && invalidOk;
  console.log(`\n── ${label}`);
  console.log('   页面标注:', scan.declaredCount, '｜实际抓到:', got.length, got.slice(0, 3).join('、') + (got.length > 3 ? '…' : ''));
  console.log('   scan.error:', scan.error || '(空)');
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  期望抓到 ${expect.size == null ? '(不限)' : expect.size} 个${expect.noInvalidError ? '、且不判扫描无效' : ''}`);
  return ok;
}

const specs = {
  // C1 故障现场：点击前列表还没渲染（beforeSig === ''），旧列表 11 行晚到
  C1: { declared: 1, staleFrom: 2, trueFrom: 6, stale: ids(11, 6210000000000), trueRows: [ids(1, 6210000000005)[0]] },
  // C2 对照组：点击前列表已渲染，签名能识别切换
  C2: { declared: 1, staleFrom: 2, trueFrom: 6, stale: ids(11, 6210000000000), trueRows: [ids(1, 6210000000005)[0]], preRendered: true },
  // C3 标注滞后：页面标注 9、真实名单 10 个（不该因为多 1 个被判扫描无效）
  C3: { declared: 9, staleFrom: 2, trueFrom: 6, stale: ids(40, 6210000001000), trueRows: ids(10, 6210000002000) },
};

(async () => {
  const c1 = report('C1 点击前列表未渲染（故障现场）', { size: 1 }, await runOnce(specs.C1));
  const c2 = report('C2 对照组：点击前列表已渲染', { size: 1 }, await runOnce(specs.C2));
  const c3 = report('C3 标注滞后：标注 9、名单 10 个', { size: 10, noInvalidError: true }, await runOnce(specs.C3));
  const ok = c1 && c2 && c3;
  console.log(ok ? '\n结论: PASS' : '\n结论: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('跑挂:', e && e.stack || e);
  process.exit(2);
});
