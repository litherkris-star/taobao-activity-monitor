'use strict';

// SKU 信息抓取工具：根据商品ID列表，连接指定店铺的监控 Chrome（CDP），
// 进入商品编辑页/活动商品管理页，抓取每个商品的 SKU 名称、货号（商家编码）和价格。
//
// 价格模式（priceMode）：
//   activity   —— 抓取普通活动价（默认）
//   superReduce —— 抓取超级立减价
//
// 用法：
//   node sku-scraper.js --shop=KS --ids=123,456,789 --mode=activity
//   node sku-scraper.js --shop=KS --ids=123,456 --mode=superReduce --json
//
// 输出：JSON 格式的 SKU 列表，每个 SKU 含 productId, skuName, itemNo(货号), price。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const CONFIG_PATH = process.env.TB_CONFIG || path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');

function localNow() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

async function log(level, message) {
  const line = `[${localNow()}] [SKU] [${String(level).toUpperCase()}] ${message}`;
  console.log(line);
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.appendFile(path.join(LOG_DIR, 'sku-scraper.log'), `${line}\n`, 'utf8');
  } catch (_) {}
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// 与 monitor.js 一致的端口分配算法。
function assignShopPorts(config) {
  const basePort = Math.max(1024, Math.min(65535, Number(config.chromeDebugPort) || 9222));
  const usedPorts = new Set();
  const shops = (Array.isArray(config.shops) ? config.shops : []);
  for (const shop of shops) {
    if (shop.enabled === false) continue;
    let port = Math.max(0, Math.min(65535, Number(shop.chromeDebugPort) || 0));
    if (!port || usedPorts.has(port)) {
      port = basePort;
      while (usedPorts.has(port)) port += 1;
    }
    usedPorts.add(port);
    shop.debugPort = port;
  }
  return shops;
}

// 构造商品编辑页 URL。千牛卖家中心新版商品编辑地址。
// 不同店铺类型（淘宝C店/天猫）URL 略有差异，这里尝试多个候选。
function buildEditUrls(productId) {
  const id = String(productId).trim();
  return [
    `https://sell.publish.tmall.com/tmall/itemEdit.htm?itemId=${id}`,
    `https://sell.publish.taobao.com/taobao/itemEdit.htm?itemId=${id}`,
    `https://myseller.taobao.com/home.htm/SellManage/on_sale?current=1&pageSize=20&queryItemId=${id}`,
  ];
}

// 注入到页面的 SKU 抓取逻辑。
// 在商品编辑页/活动商品管理页中查找 SKU 表格，提取 SKU 名称、货号、价格。
const SKU_SCRAPE_LOGIC = `
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };

  // 在表头中查找目标列的索引
  function findColumnIndex(headers, keywords) {
    const kws = keywords.map((k) => k.toLowerCase());
    for (let i = 0; i < headers.length; i++) {
      const h = String(headers[i] || '').toLowerCase();
      if (kws.some((k) => h.includes(k))) return i;
    }
    return -1;
  }

  // 从单元格文本中提取价格数字
  function extractPrice(text) {
    const m = String(text || '').match(/(\\d+(?:\\.\\d{1,2})?)/);
    return m ? Number(m[1]) : null;
  }

  // 从单元格文本中提取货号（商家编码）
  function extractItemNo(text) {
    return String(text || '').replace(/[\\s\\n\\r]+/g, ' ').trim();
  }

  async function scrapeSkuTable(mode, allowHidden) {
    const priceMode = mode || 'activity';
    // 等待页面渲染
    await sleep(2000);

    // 收集表格；allowHidden 时连隐藏表一起扫（新版 SKU 面板的商品，旧版明细表仍在 DOM 里只是不可见）
    const tables = Array.from(document.querySelectorAll('table')).filter((t) => allowHidden || isVisible(t));
    const results = [];

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr')).filter((r) => allowHidden || isVisible(r));
      if (rows.length < 2) continue;

      // 找表头行
      let headerRow = null;
      let headerCells = [];
      for (const row of rows.slice(0, 5)) {
        const cells = Array.from(row.querySelectorAll('th,td')).map(textOf);
        const headerText = cells.join('|');
        // 判断是否是 SKU 表格的表头：包含规格/SKU/编码等关键词
        if (/sku|规格|编码|货号|价格|库存|名称/i.test(headerText)) {
          headerRow = row;
          headerCells = cells;
          break;
        }
      }
      if (!headerRow) continue;

      // 映射列
      let colSkuName = findColumnIndex(headerCells, ['sku名称', '规格名称', 'sku信息', 'sku规格', '销售属性', '规格', '颜色分类', '颜色', '尺码']);
      const colItemNo = findColumnIndex(headerCells, ['商家编码', '货号', '商家sku编码', '商品编码', '编码', '商家编码(货号)']);
      const colActivityPrice = findColumnIndex(headerCells, ['活动价', '活动价格', '报名价', '促销价']);
      const colSuperReduce = findColumnIndex(headerCells, ['超级立减', '立减价', '超级立减价']);
      const colPrice = findColumnIndex(headerCells, ['价格', '单价', '一口价', '售价']);

      // 规格列兜底：匹配不到关键词（如表头为“颜色分类”“尺码”等销售属性名）时，
      // 取第一个未被其他列占用、且不属于图片/库存/操作类的非空表头列。
      if (colSkuName < 0) {
        const usedCols = [colItemNo, colActivityPrice, colSuperReduce, colPrice];
        const skipRe = /skuId|sku_id|图片|主图|数量|库存|预扣|上架|状态|搜索|操作|填写|查看|删除/i;
        for (let ci = 0; ci < headerCells.length; ci++) {
          const h = String(headerCells[ci] || '').trim();
          if (!h || usedCols.indexOf(ci) >= 0 || skipRe.test(h)) continue;
          colSkuName = ci;
          break;
        }
      }

      // 严格校验：必须同时具备 价格列 和 (商家编码/货号/编码/skuId 列)，排除属性区等伪表格
      const hasIdCol = colItemNo >= 0 || findColumnIndex(headerCells, ['skuid', 'sku_id']) >= 0;
      if (!(colPrice >= 0 && hasIdCol)) continue;
      if (colSkuName < 0 && colItemNo < 0) continue;

      // 数据行：表头之后的行
      const dataRows = rows.slice(rows.indexOf(headerRow) + 1);
      for (const row of dataRows) {
        const cells = Array.from(row.querySelectorAll('td')).map(textOf);
        if (!cells.length) continue;

        const skuName = colSkuName >= 0 ? extractItemNo(cells[colSkuName] || '') : '';
        const itemNo = colItemNo >= 0 ? extractItemNo(cells[colItemNo] || '') : '';

        // 价格选择：超级立减模式优先取超级立减列，否则取活动价列，最后回退到普通价格列
        let price = null;
        let priceColumn = '';
        if (priceMode === 'superReduce') {
          if (colSuperReduce >= 0) {
            price = extractPrice(cells[colSuperReduce] || '');
            priceColumn = '超级立减价';
          }
          if (price == null && colActivityPrice >= 0) {
            price = extractPrice(cells[colActivityPrice] || '');
            priceColumn = '活动价(回退)';
          }
        } else {
          if (colActivityPrice >= 0) {
            price = extractPrice(cells[colActivityPrice] || '');
            priceColumn = '活动价';
          }
          if (price == null && colSuperReduce >= 0) {
            price = extractPrice(cells[colSuperReduce] || '');
            priceColumn = '超级立减价(回退)';
          }
        }
        if (price == null && colPrice >= 0) {
          price = extractPrice(cells[colPrice] || '');
          priceColumn = '一口价';
        }

        // 跳过空行
        if (!skuName && !itemNo && price == null) continue;

        results.push({ skuName, itemNo, price, priceColumn });
      }

      if (results.length) break; // 找到第一个 SKU 表格就够了
    }

    // 如果表格方式没找到，尝试从页面文本中解析（新版千牛可能用 div 渲染）
    if (!results.length) {
      return { method: 'none', results: [], pageSnippet: (document.body.innerText || '').slice(0, 2000) };
    }
    return { method: 'table', results };
  }

  // 新版千牛商品编辑页可能用 div+flex 渲染 SKU，不是传统 table。
  // 这种情况下用另一种策略：找包含"商家编码"/"货号"文本的行，然后从相邻元素提取。
  async function scrapeSkuByText(mode) {
    await sleep(1500);
    const priceMode = mode || 'activity';
    const results = [];

    // 找所有包含"商家编码"或"货号"文本的节点
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = (node.nodeValue || '').trim();
        return /^(商家编码|货号|商家sku编码)$/.test(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const labelNodes = [];
    let n;
    while ((n = walker.nextNode())) labelNodes.push(n);

    for (const labelNode of labelNodes) {
      const parent = labelNode.parentElement;
      if (!parent || !isVisible(parent)) continue;
      // 向上找包含整行 SKU 信息的容器
      let rowEl = parent;
      for (let i = 0; i < 10; i++) {
        if (!rowEl.parentElement) break;
        const text = textOf(rowEl);
        if (text.length > 50 && text.length < 2000) break;
        rowEl = rowEl.parentElement;
      }
      if (!rowEl) continue;

      const rowText = textOf(rowEl);
      // 从行文本中提取货号
      const itemNoMatch = rowText.match(/(?:商家编码|货号|商家sku编码)\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
      const itemNo = itemNoMatch ? itemNoMatch[1] : '';

      // 提取 SKU 名称（通常在最前面，如"白色 / M"）
      // 找规格组合文本
      const skuNameMatch = rowText.match(/^([^]{2,80}?)(?:商家编码|货号|价格|一口价|活动价|超级立减|\\d)/);
      const skuName = skuNameMatch ? skuNameMatch[1].replace(/\\s+/g, ' ').trim() : '';

      // 提取价格
      let price = null;
      if (priceMode === 'superReduce') {
        const m = rowText.match(/(?:超级立减|立减价)\s*[:：]?\s*[¥￥]?\s*(\\d+(?:\\.\\d{1,2})?)/);
        if (m) price = Number(m[1]);
      }
      if (price == null) {
        const m = rowText.match(/(?:活动价|活动价格|报名价)\s*[:：]?\s*[¥￥]?\s*(\\d+(?:\\.\\d{1,2})?)/);
        if (m) price = Number(m[1]);
      }
      if (price == null) {
        const m = rowText.match(/(?:价格|单价|一口价|售价)\s*[:：]?\s*[¥￥]?\s*(\\d+(?:\\.\\d{1,2})?)/);
        if (m) price = Number(m[1]);
      }
      // 如果标签后面紧跟一个数字价格
      if (price == null) {
        const afterLabel = rowText.slice(rowText.indexOf(labelNode.nodeValue) + labelNode.nodeValue.length);
        const m = afterLabel.match(/\\s*[:：]?\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)/);
        if (m) price = Number(m[1]);
      }

      if (itemNo || price != null || skuName) {
        results.push({ skuName, itemNo, price, priceColumn: priceMode === 'superReduce' ? '超级立减价' : '活动价' });
      }
    }

    // 去重
    const seen = new Set();
    const unique = results.filter((r) => {
      const key = r.skuName + '|' + r.itemNo + '|' + r.price;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { method: 'text', results: unique };
  }

  window.SkuScraper = { scrapeSkuTable, scrapeSkuByText };
  return true;
})();
`;

// 判断是否在登录页
function isLoginPage(url, bodyText) {
  if (/login\.taobao\.com|login\.tmall\.com|login\.alibaba|passport|mini-login|signin|oauth/i.test(url)) return true;
  return /扫码登录|密码登录|短信登录|账户登录|欢迎登录|忘记密码|做生意上千牛/.test(bodyText);
}

async function scrapeProduct(page, productId, priceMode) {
  const urls = buildEditUrls(productId);
  let lastError = null;
  let scrapeResult = null;

  for (const url of urls) {
    try {
      await log('info', `尝试打开商品编辑页：${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // SKU 明细网格在“销售信息”标签页下，先切换过去（仅切换视图，不改动数据）。
      const salesTab = page.locator('text=销售信息').first();
      if (await salesTab.count() > 0) await salesTab.click().catch(() => {});
      // 发布页是重 JS 页面，固定等待不可靠：等到“商家编码”列出现再抓，最多等 20 秒。
      await page.waitForSelector('text=商家编码', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const currentUrl = page.url();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 5000);

      if (isLoginPage(currentUrl, bodyText)) {
        throw new Error(`登录态已失效（${currentUrl}），请先在监控 Chrome 窗口里登录千牛卖家中心。`);
      }

      // 检查是否真的到了商品编辑页（而不是404或错误页）
      if (/页面不存在|商品不存在|404|页面找不到|无权查看|没有权限/.test(bodyText)) {
        lastError = `页面返回错误：${bodyText.slice(0, 200)}`;
        continue;
      }

      // 注入抓取脚本
      await page.addScriptTag({ content: SKU_SCRAPE_LOGIC });
      const ready = await page.evaluate(() => Boolean(window.SkuScraper));
      if (!ready) throw new Error('SKU抓取脚本注入失败。');

      // 两轮表格抓取：先只扫可见表格；没有结果再扫隐藏表格（新版 SKU 面板的旧版明细表在 DOM 中但不可见）
      scrapeResult = await page.evaluate((mode) => window.SkuScraper.scrapeSkuTable(mode, false), priceMode);
      if (!scrapeResult.results || scrapeResult.results.length === 0) {
        scrapeResult = await page.evaluate((mode) => window.SkuScraper.scrapeSkuTable(mode, true), priceMode);
      }
      if (!scrapeResult.results || scrapeResult.results.length === 0) {
        // 表格方式没找到，尝试文本方式
        scrapeResult = await page.evaluate((mode) => window.SkuScraper.scrapeSkuByText(mode), priceMode);
      }

      if (scrapeResult && scrapeResult.results && scrapeResult.results.length > 0) {
        await log('info', `商品 ${productId} 抓取到 ${scrapeResult.results.length} 个SKU（方式：${scrapeResult.method}）`);
        return { ok: true, productId, skus: scrapeResult.results, url: currentUrl };
      }

      // 没抓到，记录页面片段用于调试
      lastError = `页面已加载但未识别到SKU表格。页面片段：${(scrapeResult && scrapeResult.pageSnippet || bodyText).slice(0, 300)}`;
      await log('warn', `商品 ${productId} 在 ${url} 未识别到SKU表格，尝试下一个URL`);
    } catch (error) {
      lastError = error.message || String(error);
      await log('warn', `商品 ${productId} 访问 ${url} 失败：${lastError}`);
    }
  }

  return { ok: false, productId, error: lastError || '所有候选URL均失败', skus: [] };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : '';
  };

  const shopKey = getArg('shop').trim();
  const idsStr = getArg('ids').trim();
  const priceMode = getArg('mode').trim() === 'superReduce' ? 'superReduce' : 'activity';
  const asJson = args.includes('--json');

  if (!shopKey) {
    console.error('用法：node sku-scraper.js --shop=店铺编号 --ids=商品ID1,商品ID2 [--mode=activity|superReduce] [--json]');
    process.exit(1);
  }
  if (!idsStr) {
    console.error('请用 --ids 指定商品ID，多个用英文逗号分隔。');
    process.exit(1);
  }

  const productIds = idsStr.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!productIds.length) {
    console.error('商品ID列表为空。');
    process.exit(1);
  }

  const config = loadConfig();
  const shops = assignShopPorts(config);
  const shop = shops.find((s) => s.key === shopKey);
  if (!shop) {
    console.error(`店铺 ${shopKey} 不存在。可用店铺：${shops.map((s) => s.key).join(', ')}`);
    process.exit(1);
  }

  const debugPort = shop.debugPort;
  await log('info', `开始抓取：店铺=${shop.name}（${shopKey}），端口=${debugPort}，模式=${priceMode}，商品数=${productIds.length}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  } catch (error) {
    console.error(`无法连接 Chrome 调试端口 ${debugPort}：${error.message}\n请先启动该店铺的监控 Chrome（双击"启动监控专用Chrome.bat"或运行 node start-chrome.js ${shopKey}）。`);
    process.exit(1);
  }

  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    // 只读抓取：不修改商品。自动关闭页面弹出的对话框（如离开页面前的确认），避免阻塞导航。
    page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
    await page.addInitScript(() => {
      window.addEventListener('beforeunload', (event) => { event.stopImmediatePropagation(); }, true);
    });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    const allResults = [];
    for (const productId of productIds) {
      const result = await scrapeProduct(page, productId, priceMode);
      allResults.push(result);
      await page.waitForTimeout(1500);
    }

    await page.close();

    const summary = {
      shopKey,
      shopName: shop.name,
      priceMode,
      scrapedAt: localNow(),
      total: allResults.length,
      success: allResults.filter((r) => r.ok).length,
      failed: allResults.filter((r) => !r.ok).length,
      products: allResults,
    };

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`\n===== SKU 抓取结果（${shop.name}，价格模式：${priceMode === 'superReduce' ? '超级立减价' : '活动价'}）=====`);
      for (const r of allResults) {
        console.log(`\n商品ID：${r.productId}${r.ok ? '' : ' — 失败：' + r.error}`);
        if (r.ok && r.skus.length) {
          console.log(`  SKU名称                    货号              价格`);
          for (const s of r.skus) {
            console.log(`  ${String(s.skuName).padEnd(28, ' ')} ${String(s.itemNo).padEnd(18, ' ')} ${s.price != null ? s.price + ' 元' : '未识别'}`);
          }
        }
      }
    }
    // CDP 连接会阻止事件循环退出，输出完成后主动结束进程（不关闭用户的 Chrome）。
    process.exit(0);
  } finally {
    // 只断开连接，不关闭用户的 Chrome
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
