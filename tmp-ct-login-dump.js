'use strict';
// 临时排查v2：登录创庭并 dump 活动页 tab DOM（每步即时落盘）
const { chromium } = require('playwright');
const fs = require('fs');
const { attemptPasswordLogin } = require('./password-login.js');

const OUT = 'D:/taobao-activity-monitor/tmp-tabs2.txt';
const PROFILE = 'D:/taobao-activity-monitor/profiles/CT';
const SHOP = {
  account: '创庭旗舰店:松柏',
  password: 'Shouna12345',
  activityUrl: 'https://myseller.taobao.com/home.htm/starb/tmc-next/sale/seller/campaign/item.htm?campaignId=49595&signRecordId=3496203280&unitedActivityId=49601',
};
const log = (level, msg) => {
  const line = `[${level}] ${msg}\n`;
  fs.appendFileSync(OUT, line, 'utf8');
  console.log(msg.slice(0, 100));
};

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  log('info', '=== 开始 ===');
  try {
    await page.goto(SHOP.activityUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { log('warn', 'goto1 异常: ' + e.message.slice(0, 80)); }
  await page.waitForTimeout(4000);
  log('info', 'URL1: ' + page.url().slice(0, 90));
  if (/login|passport|signin/i.test(page.url())) {
    log('info', '在登录页，尝试密码自动登录...');
    const r = await attemptPasswordLogin(page, SHOP, log, { manualAssist: false, challengeWaitSeconds: 20 });
    log('info', '登录结果: ok=' + r.ok + ' reason=' + String(r.reason).slice(0, 80));
    await page.waitForTimeout(5000);
    log('info', 'URL2: ' + page.url().slice(0, 90));
  }
  await page.waitForTimeout(8000);

  const tabs = await page.evaluate(() => {
    const norm = (el) => (el.innerText || '').replace(/\s+/g, '');
    const results = {};
    const seen = new Set();
    for (const sel of ['.next-tabs-tab-inner', '.next-tabs-tab', '[role="tab"]', '[class*="tab"]', '[class*="Tab"]', 'li', 'a']) {
      for (const el of document.querySelectorAll(sel)) {
        const t = norm(el);
        if (!t || t.length > 30 || seen.has(el)) continue;
        seen.add(el);
        (results[sel] = results[sel] || []).push({ text: t, tag: el.tagName, cls: String(el.className).slice(0, 70) });
      }
    }
    return results;
  });

  const push = (label, arr) => {
    log('info', '=== ' + label + ' ===');
    (arr || []).forEach((x) => log('dump', JSON.stringify(x)));
  };
  push('.next-tabs-tab-inner', tabs['.next-tabs-tab-inner']);
  push('[role=tab]', tabs['[role="tab"]']);
  push('[class*=tab]', tabs['[class*="tab"]']);
  push('li/a 含异常或风险', [...(tabs['li'] || []), ...(tabs['a'] || [])].filter((x) => x.text.includes('异常') || x.text.includes('风险')));
  log('info', '=== 完成 ===');
  await ctx.close();
})().catch((e) => {
  fs.appendFileSync(OUT, '[error] ' + (e.stack || e.message).slice(0, 300) + '\n', 'utf8');
  console.log('error');
  process.exit(1);
});
