'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { chromium } = require('playwright');
const { attemptPasswordLogin } = require('./password-login');

const ROOT = __dirname;
const CONFIG_PATH = process.env.TB_CONFIG || path.join(ROOT, 'config.json');
const DEFAULT_ACTIVITY_URL = 'https://myseller.taobao.com/home.htm';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('config.json 不存在，请先运行 node configure.js');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(config.shops)) throw new Error('config.json 中没有 shops 数组，请先运行 node configure.js。');
  return config;
}

async function detectShopCandidates(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const w = window.innerWidth || 1600;
    return Array.from(document.querySelectorAll('body *'))
      .filter(visible)
      .map((el) => ({ el, r: el.getBoundingClientRect(), text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter((item) => item.r.top >= 0 && item.r.top < 190 && item.text.length >= 2 && item.text.length <= 35 && /店|旗舰|官方|专营|专卖|企业|天猫|淘宝/.test(item.text))
      .sort((a, b) => b.r.right - a.r.right || a.r.top - b.r.top)
      .map((item) => item.text)
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .slice(0, 10);
  }).catch(() => []);
}

async function main() {
  const config = loadConfig();
  const key = process.argv[2];
  if (!key) {
    console.log('用法：node shop-login.js <店铺编号>');
    console.log('可用店铺：');
    config.shops.forEach((shop) => console.log(`  ${shop.key}  ${shop.name}`));
    process.exit(1);
  }
  const shop = config.shops.find((item) => item.key === key);
  if (!shop) throw new Error(`没有找到店铺编号：${key}`);
  // profileDir 留空时默认使用程序目录下的 profiles/<店铺编号>。
  shop.profileDir = String(shop.profileDir || '').trim() || path.join(ROOT, 'profiles', shop.key);
  fs.mkdirSync(shop.profileDir, { recursive: true });
  const activityUrl = shop.activityUrl || config.activityUrl || DEFAULT_ACTIVITY_URL;

  const autoMode = process.argv.includes('--auto');
  const rl = autoMode ? null : readline.createInterface({ input: stdin, output: stdout });
  const hasCredentials = Boolean(String(shop.account || '').trim() && String(shop.password || ''));
  console.log(`\n正在打开【${shop.name}】专用浏览器。`);
  console.log(`profile：${shop.profileDir}`);
  if (hasCredentials) {
    console.log('已配置登录账号密码，将自动尝试密码登录；如遇滑块/短信验证，请在浏览器里人工完成。');
  } else {
    console.log('请在弹出的浏览器里用该店铺的淘宝/天猫主账号登录千牛卖家中心，不要登录其他店铺。');
    console.log('建议用账号密码登录并让浏览器“保存密码”，下次掉线可自动重登。');
  }
  console.log('如遇到滑块/手机验证等风控，请人工完成验证。');

  const context = await chromium.launchPersistentContext(shop.profileDir, {
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    viewport: { width: 1500, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

  // 配置了账号密码时先自动登录一次（浏览器可见，风控可人工兜底）。
  if (hasCredentials) {
    const cliLog = async (level, message) => console.log(`[自动登录:${level}] ${message}`);
    const result = await attemptPasswordLogin(page, shop, cliLog, { challengeWaitSeconds: 180, manualAssist: true });
    console.log(result.ok ? '自动登录成功。' : `自动登录未成功：${result.reason}，可在浏览器里手动完成登录。`);
  }

  // --auto 模式：无交互。人工在浏览器里完成滑块/短信验证后，自动检查登录态并保存 profile。
  if (autoMode) {
    console.log('--auto 模式已启用：请在弹出的浏览器窗口里完成验证码，脚本会自动检测并保存登录态（最长等待 20 分钟）。');
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(5000);
      const currentUrl = page.url();
      const title = await page.title();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const onLoginPage = /login|passport|signin/i.test(currentUrl)
        || (/扫码登录|密码登录|短信登录|欢迎登录|忘记密码/.test(bodyText) && !/活动报名|报名记录|商品管理|出售中的宝贝/.test(bodyText));
      if (!onLoginPage) {
        const candidates = await detectShopCandidates(page);
        const expected = String(shop.name || '').replace(/\s+/g, '');
        const matched = !expected
          || bodyText.replace(/\s+/g, '').includes(expected)
          || candidates.some((name) => name.replace(/\s+/g, '').includes(expected) || expected.includes(name.replace(/\s+/g, '')));
        console.log(matched
          ? '登录成功，登录态已保存到 profile，浏览器将关闭。'
          : '已登录（店铺名校验未通过），登录态仍会保存，浏览器将关闭。');
        break;
      }
      const remainMin = Math.max(1, Math.round((deadline - Date.now()) / 60000));
      console.log(`仍在登录页：${title}，请在浏览器里人工完成滑块/短信验证（剩余约 ${remainMin} 分钟），完成后自动保存…`);
      await page.waitForTimeout(15000);
    }
    if (Date.now() >= deadline) console.log('20 分钟超时未完成登录，浏览器将关闭（不保存登录态）。');
    await context.close();
    return;
  }

  // 反复检查，直到登录成功或用户主动退出。
  while (true) {
    const answer = (await rl.question('\n请在浏览器里完成登录（密码/扫码均可）。看到卖家后台/活动报名记录页面后，回到这里按回车检查（输入 q 回车放弃）：')).trim();
    if (/^q$/i.test(answer)) {
      console.log('已放弃。浏览器关闭后不会保存有效登录态，监控程序将无法通过登录校验。');
      break;
    }
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const currentUrl = page.url();
    const title = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const onLoginPage = /login|passport|signin/i.test(currentUrl)
      || (/扫码登录|密码登录|短信登录|欢迎登录|忘记密码/.test(bodyText) && !/活动报名|报名记录|商品管理|出售中的宝贝/.test(bodyText));

    console.log(`\n当前页面：${currentUrl}`);
    console.log(`页面标题：${title}`);
    if (onLoginPage) {
      console.log('检测结果：仍在登录页，登录态尚未生效。请回到浏览器继续完成扫码/验证（可能还需要滑块或手机确认），完成后回来再按回车。');
      continue;
    }

    const candidates = await detectShopCandidates(page);
    const expected = String(shop.name || '').replace(/\s+/g, '');
    const matched = !expected
      || bodyText.replace(/\s+/g, '').includes(expected)
      || candidates.some((name) => name.replace(/\s+/g, '').includes(expected) || expected.includes(name.replace(/\s+/g, '')));
    console.log(`页面识别到的店铺候选：${candidates.join(' / ') || '未识别到'}`);
    console.log(matched
      ? `登录成功，店铺映射校验通过：${shop.name}`
      : `警告：已登录，但没有在页面中识别到配置店铺名“${shop.name}”，请确认是否登录错店铺或店铺名填写不一致。`);
    console.log('提示：如果当前地址不是活动报名记录页，请把正确的页面 URL 更新到 config.json 中该店铺的 activityUrl。');
    break;
  }
  await context.close();
  if (rl) rl.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
