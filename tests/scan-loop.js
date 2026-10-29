'use strict';
// 回归测试 B：异常名单重扫是否会把「某一次已抓干净」的结果整轮丢掉
//
// 用法（在仓库根目录）：node tests/scan-loop.js
//   退出码 0 = 每轮独立判定，成功的重扫结果被采用
//   退出码 1 = 跨轮累加污染，可用结果被误判成「数量不符」
//
// 背景：scanAnomalyTabWithRetry 早先用一个跨 3 次重扫累加的 merged，判定却是
// merged.size === declaredCount。第 1 次抓到超量（10 个 vs 页面标注 1 个）后，
// 第 2 次明明抓到干净的 1 个，累加值仍是 10 ≠ 1 → 整轮被判「数量不符」。
//
// 说明：这里把 scanAnomalyTab 整体替换成脚本化返回值（它需要真实 DOM，无法离线跑），
// 只测重扫的判定与采纳逻辑——这正是出问题的那一层。
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
  'require', '__dirname', 'module', 'exports', 'process', '__filename', 'console', '__SCAN_STUB',
  body + '\nscanAnomalyTab = __SCAN_STUB;\nreturn { scanAnomalyTabWithRetry };'
);

// 假 page：等页与刷新都是空操作（scanner 已被整体替换，不碰 DOM）
const page = { waitForTimeout: async () => {}, reload: async () => {}, evaluate: async () => null };

const cases = [
  {
    name: 'B1 第1次抓到2个(标注1)，第2次抓到1个(标注1，已一致)',
    script: [
      { anomalyIds: ['A', 'B'], declaredCount: 1, error: '' },
      { anomalyIds: ['A'], declaredCount: 1, error: '' },
    ],
    want: { error: '', size: 1 },
  },
  {
    name: 'B2 三次都稳定 1 个（对照组，应一次通过）',
    script: [
      { anomalyIds: ['A'], declaredCount: 1, error: '' },
      { anomalyIds: ['A'], declaredCount: 1, error: '' },
      { anomalyIds: ['A'], declaredCount: 1, error: '' },
    ],
    want: { error: '', size: 1 },
  },
  {
    name: 'B3 第1次扫描无效，第2次抓到2个(标注2) → 应采用第2次',
    script: [
      { anomalyIds: ['X', 'Y', 'Z'], declaredCount: null, error: '扫描无效：页面未标注异常数量却抓到 3 个' },
      { anomalyIds: ['X', 'Y'], declaredCount: 2, error: '' },
    ],
    want: { error: '', size: 2 },
  },
];

(async () => {
  let failed = 0;
  for (const c of cases) {
    let i = 0;
    const stub = async () => {
      const r = c.script[Math.min(i, c.script.length - 1)];
      i += 1;
      return { anomalyIds: new Set(r.anomalyIds), declaredCount: r.declaredCount, error: r.error };
    };
    const api = factory(fakeRequire, SANDBOX, { exports: {} }, {}, process, 'monitor.js', console, stub);
    const out = await api.scanAnomalyTabWithRetry(page, 2);
    const size = out.anomalyIds.size;
    const ok = (out.error || '') === c.want.error && size === c.want.size;
    if (!ok) failed += 1;
    console.log(`${ok ? 'GREEN' : 'RED  '} ${c.name}`);
    console.log(`      实际: error="${out.error}" ids=${size}  期望: error="${c.want.error}" ids=${c.want.size}`);
  }
  console.log(`\n结论: ${failed === 0 ? 'PASS 重扫结果按轮独立采用' : `FAIL ${failed} 个场景把可用结果判成数量不符`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
