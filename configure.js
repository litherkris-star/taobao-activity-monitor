'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const configPath = path.join(__dirname, 'config.json');
const examplePath = path.join(__dirname, 'config.example.json');
const DEFAULT_ACTIVITY_URL = 'https://myseller.taobao.com/home.htm';

function nowLocal() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function load() {
  const source = fs.existsSync(configPath) ? configPath : examplePath;
  const config = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(config.shops)) config.shops = [];
  return config;
}

async function addProducts(rl, shop) {
  if (!Array.isArray(shop.products)) shop.products = [];
  console.log(`\n为【${shop.name}】添加监控商品。商品ID直接回车表示结束。`);
  while (true) {
    const productId = (await rl.question('\n商品ID（淘宝/天猫商品数字ID）：')).trim();
    if (!productId) break;
    const existing = shop.products.find((item) => String(item.productId) === productId);
    const productName = (await rl.question(`商品名称 [${existing ? existing.productName || '' : ''}]：`)).trim() || (existing ? existing.productName : '');
    const activityName = (await rl.question(`活动名称（报警时显示，如：天猫新势力周） [${existing ? existing.activityName || '' : ''}]：`)).trim() || (existing ? existing.activityName || '' : '');
    const activityUrl = (await rl.question(`该商品的活动报名记录页URL（留空=用店铺默认页） [${existing ? existing.activityUrl || '' : ''}]：`)).trim() || (existing ? existing.activityUrl || '' : '');
    const activityDeadline = (await rl.question(`活动截止时间（过后停止报警，留空=一直监控，如 2026-09-10） [${existing ? existing.activityDeadline || '' : ''}]：`)).trim() || (existing ? existing.activityDeadline || '' : '');
    const owner = (await rl.question(`负责人 [${existing ? existing.owner || '' : ''}]：`)).trim() || (existing ? existing.owner || '' : '');
    const modeRaw = (await rl.question(`监控模式：1=按报名时间，2=加入名单后 [${existing && existing.monitorMode === 'signup_date' ? '1' : '2'}]：`)).trim();
    const monitorMode = modeRaw === '1' ? 'signup_date' : (modeRaw === '2' ? 'added_time' : (existing ? existing.monitorMode : 'added_time'));
    let monitorSince = (await rl.question(`监控开始时间 [${existing && existing.monitorSince ? existing.monitorSince : (monitorMode === 'added_time' ? nowLocal() : '例如 2026-08-01')}]：`)).trim();
    if (!monitorSince) monitorSince = existing && existing.monitorSince ? existing.monitorSince : (monitorMode === 'added_time' ? nowLocal() : '');
    const monitorActivityKeywords = (await rl.question(`监控下线活动关键词（可选，逗号分隔，如：聚划算,百亿补贴） [${existing ? existing.monitorActivityKeywords || '' : ''}]：`)).trim()
      || (existing ? existing.monitorActivityKeywords || '' : '');
    const recoveryActivityKeywords = (await rl.question(`恢复成功活动关键词（可选，逗号分隔） [${existing ? existing.recoveryActivityKeywords || '' : ''}]：`)).trim()
      || (existing ? existing.recoveryActivityKeywords || '' : '');
    const graceRaw = (await rl.question(`允许提前成功分钟数 [${existing ? Number(existing.recoveryGraceMinutes || 0) : 0}]：`)).trim();
    const recoveryGraceMinutes = graceRaw
      ? Math.max(0, Math.min(1440, Number(graceRaw) || 0))
      : (existing ? Number(existing.recoveryGraceMinutes || 0) : 0);
    const priceRaw = (await rl.question(`报名活动价（元，填 0 表示不校验价格） [${existing ? Number(existing.expectedPrice || 0) : 0}]：`)).trim();
    const expectedPrice = priceRaw
      ? Math.max(0, Number(priceRaw) || 0)
      : (existing ? Number(existing.expectedPrice || 0) : 0);
    const stockRaw = (await rl.question(`活动库存下限（件，填 0 表示不校验库存） [${existing ? Number(existing.minStock || 0) : 0}]：`)).trim();
    const minStock = stockRaw
      ? Math.max(0, Math.floor(Number(stockRaw) || 0))
      : (existing ? Number(existing.minStock || 0) : 0);
    const currentEnabled = existing ? existing.enabled !== false : true;
    const statusRaw = (await rl.question(`监控状态：1=启用，2=暂停 [${currentEnabled ? '1' : '2'}]：`)).trim();
    const enabled = statusRaw === '2' ? false : (statusRaw === '1' ? true : currentEnabled);
    const item = {
      shopName: shop.name,
      productId,
      productName,
      activityName,
      activityUrl,
      activityDeadline,
      owner,
      monitorMode,
      monitorSince,
      monitorActivityKeywords,
      recoveryActivityKeywords,
      recoveryGraceMinutes,
      expectedPrice,
      minStock,
      enabled,
    };
    if (enabled) {
      item.resumedAt = nowLocal();
      if (existing) delete existing.pausedAt;
    } else {
      item.pausedAt = nowLocal();
      if (existing) delete existing.resumedAt;
    }
    if (existing) Object.assign(existing, item); else shop.products.push(item);
    console.log(`已保存：${productId}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const config = load();
  console.log('\n=== 淘宝/天猫多店铺活动异常监控配置 ===\n');
  console.log('钉钉机器人 Webhook 请直接编辑 config.json 的 dingtalk 字段，测试：node notification-test.js');
  const interval = await rl.question(`检测间隔分钟数 [${config.intervalMinutes || 30}]：`);
  if (interval.trim()) config.intervalMinutes = Math.max(Number(interval) || 30, 1);

  if (!Array.isArray(config.shops)) config.shops = [];
  console.log('\n当前店铺：');
  config.shops.forEach((shop) => console.log(`- ${shop.key}: ${shop.name} | profile=${shop.profileDir} | 商品=${(shop.products || []).length}`));
  const keep = await rl.question(`\n保留当前 ${config.shops.length} 个店铺？[Y/n]：`);
  if (/^n/i.test(keep.trim())) config.shops = [];

  console.log('\n开始添加或修改店铺。店铺编号直接回车表示结束。建议使用 shop01、shop02。');
  while (true) {
    const key = (await rl.question('\n店铺编号：')).trim();
    if (!key) break;
    let shop = config.shops.find((item) => item.key === key);
    if (!shop) {
      shop = { key, name: '', profileDir: path.join(__dirname, 'profiles', key), activityUrl: config.activityUrl || DEFAULT_ACTIVITY_URL, enabled: true, verifyShopName: true, products: [] };
      config.shops.push(shop);
    }
    const name = (await rl.question(`店铺名称（必须与后台显示一致） [${shop.name || ''}]：`)).trim();
    if (name) shop.name = name;
    const profile = (await rl.question(`独立登录 profile 路径 [${shop.profileDir}]：`)).trim();
    if (profile) shop.profileDir = profile;
    console.log('活动报名记录页网址：登录千牛卖家中心后，进入“营销中心 → 活动报名记录（或淘营销 → 我的活动）”，复制浏览器地址栏 URL。');
    const url = (await rl.question(`活动报名记录网址 [${shop.activityUrl || DEFAULT_ACTIVITY_URL}]：`)).trim();
    if (url) shop.activityUrl = url;
    console.log('登录账号密码（可选）：配置后掉线时监控会自动尝试密码登录；遇到滑块/短信需在浏览器人工完成。直接回车跳过。');
    const account = (await rl.question(`登录账号 [${shop.account || ''}]：`)).trim();
    if (account) shop.account = account;
    const password = (await rl.question(`登录密码 [${shop.password ? '已设置，回车保持不变' : '未设置'}]：`)).trim();
    if (password) shop.password = password;
    const verify = (await rl.question(`是否校验页面店铺名称，防止串店？[Y/n]：`)).trim();
    shop.verifyShopName = !/^n/i.test(verify);
    const enabled = (await rl.question(`是否启用该店铺？[Y/n]：`)).trim();
    shop.enabled = !/^n/i.test(enabled);
    const editProducts = (await rl.question(`添加或修改该店铺商品？[Y/n]：`)).trim();
    if (!/^n/i.test(editProducts)) await addProducts(rl, shop);
    shop.products = (shop.products || []).map((product) => ({ ...product, shopName: shop.name }));
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`\n配置已保存：${configPath}`);
  console.log('\n每个新店铺都要单独登录一次（需要本机有图形界面或转发显示）：');
  config.shops.forEach((shop) => console.log(`  node shop-login.js ${shop.key}`));
  console.log('\n完成登录后测试：node monitor.js --once\n');
  rl.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
