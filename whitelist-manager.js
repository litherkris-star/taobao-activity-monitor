'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const CONFIG_PATH = process.env.TB_CONFIG || path.join(__dirname, 'config.json');

function nowLocal() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function enabledValue(value) {
  return value !== false && !/^(no|否|false|0|停用|暂停)$/i.test(String(value == null ? 'yes' : value));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在：${CONFIG_PATH}\n请先运行 node configure.js`);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
  if (!Array.isArray(config.shops)) throw new Error('当前 config.json 不是多店铺格式，请先运行 node configure.js。');
  config.shops.forEach((shop) => {
    if (!Array.isArray(shop.products)) shop.products = [];
    shop.products.forEach((product) => { product.enabled = enabledValue(product.enabled); });
  });
  return config;
}

function saveConfig(config) {
  const backup = `${CONFIG_PATH}.backup-${Date.now()}`;
  fs.copyFileSync(CONFIG_PATH, backup);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return backup;
}

function allProducts(config) {
  const rows = [];
  for (const shop of config.shops) {
    for (const product of shop.products || []) {
      rows.push({ shop, product });
    }
  }
  return rows;
}

function printList(config) {
  console.log('\n=== 当前监控白名单状态 ===\n');
  let index = 0;
  for (const shop of config.shops) {
    const products = shop.products || [];
    const active = products.filter((item) => enabledValue(item.enabled)).length;
    console.log(`${shop.key}｜${shop.name}｜启用 ${active}/${products.length}`);
    for (const product of products) {
      index += 1;
      const status = enabledValue(product.enabled) ? '监控中' : '已暂停';
      const pauseInfo = !enabledValue(product.enabled) && product.pausedAt ? `｜暂停时间 ${product.pausedAt}` : '';
      const checks = [];
      if (Number(product.expectedPrice || 0) > 0) checks.push(`价=${product.expectedPrice}`);
      if (Number(product.minStock || 0) > 0) checks.push(`库存下限=${product.minStock}`);
      const checkInfo = checks.length ? `｜校验：${checks.join('，')}` : '';
      const activityInfo = product.activityName ? `｜活动：${product.activityName}` : '';
      console.log(`  ${String(index).padStart(2, '0')}. [${status}] ${product.productId}｜${product.productName || '未填写名称'}${activityInfo}｜负责人：${product.owner || '未填写'}${checkInfo}${pauseInfo}`);
    }
    if (!products.length) console.log('  （没有商品）');
    console.log('');
  }
  if (index === 0) console.log('当前没有白名单商品。\n');
  return allProducts(config);
}

function findProduct(config, shopKey, productId) {
  const shop = config.shops.find((item) => item.key === shopKey);
  if (!shop) throw new Error(`找不到店铺：${shopKey}`);
  const product = (shop.products || []).find((item) => String(item.productId) === String(productId));
  if (!product) throw new Error(`店铺 ${shopKey} 中找不到商品ID：${productId}`);
  return { shop, product };
}

function setProductState(product, enabled) {
  product.enabled = enabled;
  if (enabled) {
    product.resumedAt = nowLocal();
    delete product.pausedAt;
  } else {
    product.pausedAt = nowLocal();
    delete product.resumedAt;
  }
}

function applyCommand(config, action, shopKey, productId) {
  const { shop, product } = findProduct(config, shopKey, productId);
  if (action === 'pause') setProductState(product, false);
  else if (action === 'resume') setProductState(product, true);
  else if (action === 'toggle') setProductState(product, !enabledValue(product.enabled));
  else throw new Error(`未知操作：${action}`);
  return { shop, product };
}

async function interactive(config) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const rows = printList(config);
      console.log('操作：');
      console.log('  1 = 暂停一个商品');
      console.log('  2 = 恢复一个商品');
      console.log('  3 = 切换商品状态（监控中 ↔ 已暂停）');
      console.log('  4 = 暂停某个店铺的全部商品');
      console.log('  5 = 恢复某个店铺的全部商品');
      console.log('  0 = 保存并退出');
      console.log('  q = 不保存退出');
      const choice = (await rl.question('\n请选择：')).trim().toLowerCase();
      if (choice === 'q') {
        console.log('已退出，没有保存修改。');
        return false;
      }
      if (choice === '0' || choice === '') return true;

      if (['1', '2', '3'].includes(choice)) {
        if (!rows.length) continue;
        const rawIndex = (await rl.question('请输入商品前面的序号：')).trim();
        const selected = rows[Number(rawIndex) - 1];
        if (!selected) {
          console.log('序号无效，请重新选择。');
          continue;
        }
        if (choice === '1') setProductState(selected.product, false);
        if (choice === '2') setProductState(selected.product, true);
        if (choice === '3') setProductState(selected.product, !enabledValue(selected.product.enabled));
        console.log(`已设置：${selected.shop.name}｜${selected.product.productId}｜${enabledValue(selected.product.enabled) ? '监控中' : '已暂停'}`);
        continue;
      }

      if (['4', '5'].includes(choice)) {
        console.log('\n店铺编号：');
        config.shops.forEach((shop) => console.log(`  ${shop.key}｜${shop.name}`));
        const shopKey = (await rl.question('请输入店铺编号：')).trim();
        const shop = config.shops.find((item) => item.key === shopKey);
        if (!shop) {
          console.log('店铺编号不存在。');
          continue;
        }
        const enabled = choice === '5';
        for (const product of shop.products || []) setProductState(product, enabled);
        console.log(`已将【${shop.name}】全部商品设置为：${enabled ? '监控中' : '已暂停'}`);
        continue;
      }

      console.log('无效选项，请重新输入。');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const config = loadConfig();
  const [, , action, shopKey, productId] = process.argv;

  if (action === 'list') {
    printList(config);
    return;
  }

  if (['pause', 'resume', 'toggle'].includes(action)) {
    if (!shopKey || !productId) {
      throw new Error(`用法：node whitelist-manager.js ${action} <店铺编号> <商品ID>`);
    }
    const result = applyCommand(config, action, shopKey, productId);
    const backup = saveConfig(config);
    console.log(`已保存：${result.shop.name}｜${result.product.productId}｜${enabledValue(result.product.enabled) ? '监控中' : '已暂停'}`);
    console.log(`备份文件：${backup}`);
    console.log('后台服务会在下一轮检测自动读取新状态；需要立即生效可执行 ./manage.sh restart');
    return;
  }

  if (action && !['help', '--help', '-h'].includes(action)) {
    throw new Error(`未知命令：${action}`);
  }
  if (['help', '--help', '-h'].includes(action)) {
    console.log(`\n用法：\n  node whitelist-manager.js\n  node whitelist-manager.js list\n  node whitelist-manager.js pause shop01 123456789\n  node whitelist-manager.js resume shop01 123456789\n  node whitelist-manager.js toggle shop01 123456789\n`);
    return;
  }

  const shouldSave = await interactive(config);
  if (!shouldSave) return;
  const backup = saveConfig(config);
  console.log(`\n白名单状态已保存：${CONFIG_PATH}`);
  console.log(`自动备份：${backup}`);
  console.log('暂停的商品从下一轮起不再检测、不再报警；恢复后会继续使用原监控开始时间和自动恢复规则。');
  console.log('后台服务会在下一轮检测自动读取新状态；需要立即生效可执行：./manage.sh restart\n');
}

main().catch((error) => {
  console.error(`错误：${error.message || error}`);
  process.exit(1);
});
