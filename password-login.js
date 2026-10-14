'use strict';

// 账号密码自动登录模块：被 monitor.js（掉线自动重登）和 shop-login.js（首登辅助）共用。
// 说明：淘宝/千牛风控严格，密码登录经常会触发滑块/短信验证，本模块采用“自动填写 + 人工兜底”策略：
// 1. 自动切到密码登录、填写账号密码、勾选协议、点击登录；
// 2. 登录后直接成功的，返回 ok；
// 3. 出现滑块/短信等验证且浏览器可见（人工可操作）时，等待人工完成，最长 challengeWaitSeconds 秒；
// 4. 无法自动完成时返回 ok=false 和原因，由调用方决定报警或提示。

const LOGIN_URL = 'https://loginmyseller.taobao.com/';

const LOGIN_URL_RE = /loginmyseller\.taobao\.com|login\.taobao\.com|login\.tmall\.com|login\.alibaba|passport|mini-login|signin|\/login/i;
const BACKEND_WORDS_RE = /活动报名|报名记录|营销活动|出售中的宝贝|已卖出的宝贝|商品管理|交易管理|商家中心/;
const CHALLENGE_WORDS_RE = /滑块|拖动下方滑块|向右滑动|安全验证|短信验证|验证码|身份验证|扫码验证/;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 在页面及所有 iframe 里查找第一个匹配 selector 且可见的元素，返回 { frame, locator }。
async function findVisibleInFrames(page, selectors) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.count() && await locator.isVisible({ timeout: 800 }).catch(() => false)) {
          return { frame, locator };
        }
      } catch (_) { /* 忽略单个选择器失败 */ }
    }
  }
  return null;
}

// 在页面及所有 iframe 里按文本点击（如“密码登录”标签）。
async function clickTextInFrames(page, texts) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const text of texts) {
      try {
        const locator = frame.getByText(text, { exact: false }).first();
        if (await locator.count() && await locator.isVisible({ timeout: 800 }).catch(() => false)) {
          await locator.click({ timeout: 3000 }).catch(() => {});
          return true;
        }
      } catch (_) { /* 忽略 */ }
    }
  }
  return false;
}

async function pageSnapshot(page) {
  const url = page.url();
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 20000);
  return { url, bodyText };
}

function isLoginUrl(url) {
  return LOGIN_URL_RE.test(url);
}

function isBackend(url, bodyText) {
  return !isLoginUrl(url) && BACKEND_WORDS_RE.test(bodyText);
}

function hasChallenge(bodyText) {
  return CHALLENGE_WORDS_RE.test(bodyText);
}

// 轮询等待密码输入框出现（登录页表单/iframe 加载需要时间），最长 timeoutMs 毫秒。
async function waitForPasswordInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findVisibleInFrames(page, [
      'input[type="password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[placeholder*="密码"]',
    ]);
    if (found) return found;
    await sleep(700);
  }
  return null;
}

// 可靠写入输入框：写后立即读回校验，不一致逐级换策略重填，最多 3 级。
// 背景：千牛登录页账号框会弹历史账号下拉吞掉按键，逐字输入可能被截断，必须写后校验。
async function setInputValue(locator, value, log, label) {
  const target = String(value);
  for (let level = 1; level <= 3; level += 1) {
    try {
      await locator.click({ timeout: 5000 });
    } catch (_) { /* 忽略 */ }
    await locator.press('Escape').catch(() => {}); // 关掉账号历史下拉，防止吞键
    if (level === 1) {
      // 策略1：原生 setter 一次性写入 + 补发 input/change 事件。
      // 原子写入不会被逐字吞键；走 HTMLInputElement 原生 setter 也能被 React 受控组件正确识别。
      await locator.evaluate((el, v) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, target).catch(() => {});
    } else if (level === 2) {
      // 策略2：清空后原子 fill。
      await locator.fill('').catch(() => {});
      await locator.fill(target).catch(() => {});
    } else {
      // 策略3：全选删除后慢速逐字输入。
      await locator.click({ clickCount: 3 }).catch(() => {});
      await locator.press('Delete').catch(() => {});
      await locator.type(target, { delay: 160 }).catch(() => {});
    }
    const current = await locator.inputValue().catch(() => '');
    if (current === target) return true;
    await log('warn', `${label}写入校验失败（第 ${level} 次，读到“${current.slice(0, 6)}…”），换策略重试。`);
    await sleep(800);
  }
  return false;
}

// 自动填写账号密码并提交。返回 { ok, reason, needHuman }。
async function fillAndSubmit(page, account, password, log) {
  // 1. 切到“密码登录”标签（部分版本默认就是密码登录，点不到也不影响后续找输入框）。
  const switched = await clickTextInFrames(page, ['密码登录', '帐号密码登录', '账号密码登录']);
  if (switched) {
    await log('info', '已切换到密码登录标签。');
    await sleep(1500);
  }

  // 2. 等密码输入框出现（页面/iframe 渲染需要时间，轮询最长 12 秒）。
  const pwdFound = await waitForPasswordInput(page, 12000);
  if (!pwdFound) return { ok: false, reason: '页面上找不到密码输入框（页面可能未加载完成或结构已变更）' };

  // 3. 找账号输入框：优先常见 name/id/placeholder，找不到就取密码框之前的第一个可见文本框。
  let accountLocator = null;
  const accountFound = await findVisibleInFrames(page, [
    'input[name*="loginId" i]',
    'input[id*="login-id" i]',
    'input[name*="account" i]',
    'input[placeholder*="手机"]',
    'input[placeholder*="会员名"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="账号"]',
    'input[placeholder*="账户"]',
  ]);
  if (accountFound) {
    accountLocator = accountFound.locator;
  } else {
    try {
      accountLocator = pwdFound.frame.locator('input:visible:not([type="password"]):not([type="checkbox"]):not([type="radio"])').first();
      if (!(await accountLocator.count())) accountLocator = null;
    } catch (_) { accountLocator = null; }
  }
  if (!accountLocator) return { ok: false, reason: '页面上找不到账号输入框（页面结构可能已变更）' };

  // 4. 写入账号密码并逐字段校验（写入可能被页面下拉/脚本截断，必须确认）。
  const accOk = await setInputValue(accountLocator, account, log, '账号');
  if (!accOk) return { ok: false, reason: '账号写入多次校验失败（页面可能拦截了自动输入），请手动登录' };
  const pwdOk = await setInputValue(pwdFound.locator, password, log, '密码');
  if (!pwdOk) return { ok: false, reason: '密码写入多次校验失败（页面可能拦截了自动输入），请手动登录' };
  await log('info', '账号密码已自动填写并通过写入校验。');
  await page.keyboard.press('Escape').catch(() => {}); // 提交前再关一次可能弹出的下拉

  // 5. 勾选“同意协议”类复选框（存在且未勾选时）。
  const agree = await findVisibleInFrames(page, ['input[type="checkbox"]']);
  if (agree) {
    try {
      const checked = await agree.locator.isChecked().catch(() => true);
      if (!checked) await agree.locator.check({ timeout: 2000 }).catch(() => {});
    } catch (_) { /* 忽略 */ }
  }

  // 6. 点击登录按钮：必须优先 button/submit 等可点击元素。
  // 不能用裸文本“登录”全页找——千牛登录页顶部标题“欢迎登录 做生意上千牛”会先被命中，点了标题而不是按钮。
  let submitted = false;
  const btn = await findVisibleInFrames(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登录")',
    'a:has-text("登 录")',
    '[role="button"]:has-text("登录")',
  ]);
  if (btn) {
    await btn.locator.click({ timeout: 3000 }).catch(() => {});
    submitted = true;
  }
  if (!submitted) submitted = await clickTextInFrames(page, ['登 录', '同意协议并登录']);
  if (!submitted) {
    // 兜底：在密码框上回车提交。
    await pwdFound.locator.press('Enter').catch(() => {});
  }
  await log('info', '已提交登录表单，等待登录结果…');
  return { ok: true, submitted: true };
}

/**
 * 尝试用账号密码自动登录。
 * @param {import('playwright').Page} page 当前标签页
 * @param {object} shop 店铺配置（需含 account / password / activityUrl）
 * @param {function} log 日志函数 (level, message) => Promise|void
 * @param {object} options { challengeWaitSeconds=100, manualAssist=true }
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
async function attemptPasswordLogin(page, shop, log, options = {}) {
  const account = String(shop.account || '').trim();
  const password = String(shop.password || '');
  if (!account || !password) return { ok: false, reason: '未配置店铺登录账号或密码' };

  const challengeWaitSeconds = Math.max(30, Math.min(300, Number(options.challengeWaitSeconds) || 100));
  const manualAssist = options.manualAssist !== false;
  const targetUrl = String(shop.activityUrl || '').trim() || 'https://myseller.taobao.com/home.htm';

  try {
    const snap0 = await pageSnapshot(page);
    if (!isLoginUrl(snap0.url)) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3000);
    }

    let fillResult = await fillAndSubmit(page, account, password, log);
    if (!fillResult.ok) {
      // 页面可能还没渲染完，等 3 秒重试一次。
      await sleep(3000);
      fillResult = await fillAndSubmit(page, account, password, log);
    }
    if (!fillResult.ok) return { ok: false, reason: fillResult.reason };

    // 7. 等待登录结果：成功 / 风控挑战 / 失败。
    const deadline = Date.now() + 40000;
    let challenged = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const snap = await pageSnapshot(page);
      if (isBackend(snap.url, snap.bodyText) || (!isLoginUrl(snap.url) && !hasChallenge(snap.bodyText))) {
        await log('info', '密码登录成功，已进入后台。');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
        await sleep(3000);
        return { ok: true, reason: '' };
      }
      if (hasChallenge(snap.bodyText)) { challenged = true; break; }
    }

    if (challenged && manualAssist) {
      await log('warn', `登录触发风控验证（滑块/短信/扫码），请在浏览器窗口里人工完成，最长等待 ${challengeWaitSeconds} 秒…`);
      const challengeDeadline = Date.now() + challengeWaitSeconds * 1000;
      while (Date.now() < challengeDeadline) {
        await sleep(3000);
        const snap = await pageSnapshot(page);
        if (isBackend(snap.url, snap.bodyText) || (!isLoginUrl(snap.url) && !hasChallenge(snap.bodyText))) {
          await log('info', '人工验证完成，登录成功。');
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
          await sleep(3000);
          return { ok: true, reason: '' };
        }
      }
      return { ok: false, reason: `触发风控验证且 ${challengeWaitSeconds} 秒内未人工完成` };
    }
    if (challenged) return { ok: false, reason: '触发风控验证（滑块/短信），当前为无界面模式无法人工完成' };

    const snapEnd = await pageSnapshot(page);
    if (isLoginUrl(snapEnd.url)) {
      const errorMatch = snapEnd.bodyText.match(/(账密错误|账号或密码错误|密码错误|账号或密码|账户名与密码|账号不存在|存在风险|已被冻结|验证失败)[^。\n]{0,30}/);
      return { ok: false, reason: errorMatch ? `登录被驳回：${errorMatch[0]}` : '提交后仍停留在登录页（可能密码错误或需额外验证）' };
    }
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: `自动登录过程出错：${error.message || error}` };
  }
}

module.exports = { attemptPasswordLogin, fillAndSubmit };
