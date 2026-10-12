let state = { shops: [], ownerPhones: {} };
const PAGE_TITLES = { status: '检测总览', board: '信息看板', shops: '店铺与商品', alerts: '报警设置' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 店铺标签色（0-3 稳定映射，蓝/黄/绿/青，避免红色与错误混淆）
function hashColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h % 4;
}
// 汇总数字滚动动画（0 → 目标值，缓出 700ms）
function animateNumber(el, target) {
  const duration = 700;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = String(target);
  }
  requestAnimationFrame(tick);
}

async function api(path, options, retried) {
  options = options || {};
  options.headers = Object.assign({}, options.headers, {
    'X-Admin-Token': encodeURIComponent(localStorage.getItem('adminToken') || ''),
    'X-Operator': encodeURIComponent(localStorage.getItem('operatorName') || ''),
  });
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.needToken && !retried) {
    const token = prompt('该管理后台已设置口令，请输入管理口令：');
    if (token !== null) {
      localStorage.setItem('adminToken', token.trim());
      return api(path, options, true);
    }
  }
  if (!res.ok) throw new Error(data.error || data.output || ('HTTP ' + res.status));
  return data;
}

async function loadConfig() {
  const data = await api('/api/config');
  state.shops = data.shops || [];
  state.ownerPhones = data.ownerPhones || {};
  state.updatedAt = data.updatedAt || '';
  document.getElementById('ownerPhonesInput').value = Object.entries(state.ownerPhones).map(([name, phone]) => `${name}=${phone}`).join('\n');
  document.getElementById('intervalInput').value = data.intervalMinutes || 30;
  document.getElementById('repeatInput').value = data.anomalyRepeatMinutes !== undefined ? data.anomalyRepeatMinutes : 30;
  // 免打扰时段：拆分回填开始/结束两个时间选择框
  const qhMatch = String(data.quietHours || '').match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  document.getElementById('quietStart').value = qhMatch ? qhMatch[1] : '';
  document.getElementById('quietEnd').value = qhMatch ? qhMatch[2] : '';
  document.getElementById('reportEnabled').checked = data.dailyReportEnabled !== false;
  document.getElementById('reportTime').value = data.dailyReportTime || '21:00';
  document.getElementById('reportDingEnabled').checked = data.dailyReportDingTalk === true;
  document.getElementById('restartEnabled').checked = data.autoRestartEnabled !== false;
  document.getElementById('restartTime').value = data.autoRestartTime || '04:00';
  const phoneCount = Object.keys(state.ownerPhones).length;
  document.getElementById('ownerPhonesSummary').textContent = phoneCount ? `已配置 ${phoneCount} 人` : '未配置';
  renderShops();
  initOperator();
  if (!document.getElementById('pageStatus').classList.contains('hidden')) { loadResults(); refreshPauseButton(); }
}

// 手机号映射模块默认收起，点「展开/收起」切换编辑区。
function toggleOwnerPhones() {
  const body = document.getElementById('ownerPhonesBody');
  const btn = document.getElementById('btnOwnerPhonesToggle');
  const willShow = body.classList.contains('hidden');
  body.classList.toggle('hidden');
  btn.textContent = willShow ? '收起' : '展开';
}

// 解析负责人手机号映射文本（每行：姓名=手机号）。
function parseOwnerPhonesInput() {
  const text = document.getElementById('ownerPhonesInput').value;
  const map = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.includes('=') ? '=' : (line.includes('：') ? '：' : (line.includes(':') ? ':' : ''));
    if (!sep) throw new Error(`手机号映射格式不对（应为 姓名=手机号）：${line}`);
    const name = line.slice(0, line.indexOf(sep)).trim();
    const rawPhone = line.slice(line.indexOf(sep) + 1).trim();
    let phone = rawPhone.replace(/\D/g, '');
    if (phone.length === 13 && phone.startsWith('86')) phone = phone.slice(2);
    if (!name || !/^\d{5,15}$/.test(phone)) throw new Error(`手机号映射格式不对（只需填 11 位手机号，如 姓名=13812345678）：${line}`);
    map[name] = phone;
  }
  return map;
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('saveToast');
  const msgEl = document.getElementById('saveToastMsg');
  if (!toast) return;
  msgEl.textContent = msg;
  toast.classList.remove('hide');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(() => toast.style.display = 'none', 300);
  }, 3000);
}

// 检测趋势看板：最近 N 轮「活动异常数 / 店铺失败数」折线 + 各店铺累计失败次数柱状。
let trendChartStore = {};
async function loadHistory() {
  const box = document.getElementById('trendChart');
  if (!box) return;
  try {
    const data = await api('/api/history?limit=48');
    const hist = data.history || [];
    const hint = document.getElementById('trendHint');
    if (hint) hint.textContent = `最近 ${hist.length} 轮检测的异常数 / 店铺失败数`;
    if (!hist.length) {
      box.innerHTML = '<span class="muted">暂无历史数据（下一轮检测后开始记录）</span>';
      const box2 = document.getElementById('shopErrorChart');
      if (box2) { box2.innerHTML = ''; if (trendChartStore.shopError) { trendChartStore.shopError.dispose(); trendChartStore.shopError = null; } }
      return;
    }
    const times = hist.map((h) => String(h.time || '').slice(5, 16)); // MM-DD HH:MM
    const anomalies = hist.map((h) => Number(h.anomalies) || 0);
    const errors = hist.map((h) => Number(h.errors) || 0);
    const shopErr = {};
    (hist || []).forEach((h) => (h.shopErrorDetails || []).forEach((s) => {
      const name = String(s).split(':')[0];
      if (name) shopErr[name] = (shopErr[name] || 0) + 1;
    }));
    renderTrendChart('trendChart', ['活动异常数', '店铺失败数'], times, [anomalies, errors], false);
    const shopNames = Object.keys(shopErr);
    if (shopNames.length) {
      renderTrendChart('shopErrorChart', ['店铺失败次数'], shopNames, [shopNames.map((n) => shopErr[n])], true);
    } else if (trendChartStore.shopError) {
      trendChartStore.shopError.dispose();
      trendChartStore.shopError = null;
      document.getElementById('shopErrorChart').innerHTML = '<span class="muted">近 48 轮无店铺失败</span>';
    }
  } catch (_) {}
}

function renderTrendChart(id, legend, xData, seriesData, isBar) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!window.echarts) { el.innerHTML = '<span class="muted">图表库未加载（vendor/echarts.min.js 缺失）</span>'; return; }
  if (trendChartStore[id]) trendChartStore[id].dispose();
  const chart = echarts.init(el);
  trendChartStore[id] = chart;
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: legend, top: 0, textStyle: { fontSize: 11 } },
    grid: { left: 42, right: 16, top: 30, bottom: 26 },
    xAxis: { type: 'category', data: xData, axisLabel: { fontSize: 10, interval: Math.max(0, Math.floor(xData.length / 9)) } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
    series: seriesData.map((data, i) => ({
      name: legend[i],
      type: isBar ? 'bar' : 'line',
      data,
      smooth: !isBar,
      symbolSize: 5,
      barMaxWidth: 26,
      itemStyle: { color: isBar ? '#d48806' : (i === 0 ? '#d54941' : '#3370ff') },
    })),
  });
}

// 检测总览不再使用二级导航：巡检控制、商品结果、检测日志平铺同页显示，直接加载商品结果即可。
// ===== 信息看板：服务自动恢复记录 + 每日日报（钉钉不再推送这两类，统一在后台查看） =====
let boardReportCache = [];
async function loadBoard() {
  try {
    const data = await api('/api/board');
    renderBoardEvents(data.serviceEvents || []);
    boardReportCache = data.dailyReports || [];
    renderBoardDates();
    if (boardReportCache.length) showBoardReport(0);
  } catch (error) {
    document.getElementById('boardEvents').innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`;
  }
}
function renderBoardEvents(events) {
  const box = document.getElementById('boardEvents');
  if (!events.length) {
    box.innerHTML = '<div class="empty">暂无服务恢复记录（守护脚本运行正常，服务未中断过）</div>';
    return;
  }
  box.innerHTML = events.slice().reverse().map((e) => `
    <div class="log-item">
      <span class="lt">${esc(e.time)}</span>
      <span class="shop-tag c0">${esc(e.service)}</span>
      <span class="txt">${esc(e.message)}</span>
    </div>`).join('');
}
function renderBoardDates() {
  const box = document.getElementById('boardReportDates');
  if (!boardReportCache.length) {
    box.innerHTML = '<span class="muted">（暂无日报，每天按配置时间自动生成）</span>';
    document.getElementById('boardReportDetail').textContent = '（暂无日报）';
    return;
  }
  box.innerHTML = boardReportCache.map((r, idx) => `<button class="btn-plain btn-mini${idx === 0 ? ' board-date-active' : ''}" id="bd-${idx}" onclick="showBoardReport(${idx})">${esc(r.date)}</button>`).join('');
}
function showBoardReport(idx) {
  const r = boardReportCache[idx];
  if (!r) return;
  document.querySelectorAll('#boardReportDates .board-date-active').forEach((b) => b.classList.remove('board-date-active'));
  const btn = document.getElementById('bd-' + idx);
  if (btn) btn.classList.add('board-date-active');
  document.getElementById('boardReportDetail').textContent = r.markdown || '（该日无内容）';
  document.getElementById('boardReportHint').textContent = r.generatedAt ? '生成于 ' + r.generatedAt : '点击日期查看当日简报';
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const pageMap = { status: 'pageStatus', board: 'pageBoard', shops: 'pageShops', alerts: 'pageAlerts' };
  Object.entries(pageMap).forEach(([key, id]) => {
    const el = document.getElementById(id);
    const isActive = key === tab;
    el.classList.toggle('hidden', !isActive);
    if (isActive) {
      // 重新触发页面进入动画（先移除强制 reflow 再添加）
      el.classList.remove('page-enter');
      void el.offsetWidth;
      el.classList.add('page-enter');
    }
  });
  document.getElementById('pageTitle').textContent = PAGE_TITLES[tab] || '';
  const saveState = document.getElementById('saveState');
  saveState.style.display = tab === 'shops' ? '' : 'none';
  if (tab === 'status') { loadResults(); refreshPauseButton(); }
  // 信息看板页：一次性加载服务状态 + 日报 + 操作日志 + 检测趋势（各带自己的刷新按钮）
  if (tab === 'board') { loadBoard(); loadOperations(); loadHistory(); loadAnomalyState(); }
}

// ===== 信息看板：异常持续记录 =====
// 时长显示：<60 分钟显示「X 分钟」；≥60 分钟显示「X 小时 Y 分」。
function durationText(startText, endText) {
  const t = (new Date(String(endText).replace(' ', 'T')).getTime()) - (new Date(String(startText).replace(' ', 'T')).getTime());
  if (!Number.isFinite(t) || t < 0) return '';
  const min = Math.round(t / 60000);
  if (min < 60) return min + ' 分钟';
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
}
async function loadAnomalyState() {
  const box = document.getElementById('boardAnomaly');
  if (!box) return;
  try {
    const data = await api('/api/anomaly-state');
    renderAnomalyState(data.ongoing || [], data.recoveries || []);
  } catch (error) {
    box.innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`;
  }
}
function renderAnomalyState(ongoing, recoveries) {
  const box = document.getElementById('boardAnomaly');
  const lines = [];
  // 1) 持续中的异常（商品 + 店铺）
  if (ongoing.length) {
    lines.push('<div class="anomaly-group-title">持续中（' + ongoing.length + '）</div>');
    for (const item of ongoing) {
      const dur = durationText(item.start, new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 19).replace(/\//g, '-'));
      lines.push(`<div class="log-item">
        <span class="shop-tag c${hashColor(item.shopKey)}">${esc(item.shopName)}</span>
        <span class="txt">${item.type === 'shop'
          ? '<b>店铺异常</b>：自 ' + esc(item.start) + ' 异常，已持续 ' + esc(dur)
          : '商品 ' + esc(item.productId) + (item.title ? '（' + esc(item.title) + '）' : '') + '：自 ' + esc(item.start) + ' 异常，已持续 ' + esc(dur)}</span>
      </div>`);
    }
  }
  // 2) 最近已恢复的持续段
  const rec = recoveries.filter((r) => r.start && r.end);
  if (rec.length) {
    lines.push('<div class="anomaly-group-title">最近恢复（' + rec.length + '）</div>');
    for (const item of rec) {
      const dur = durationText(item.start, item.end);
      lines.push(`<div class="log-item">
        <span class="shop-tag c${hashColor(item.shopKey)}">${esc(item.shopName)}</span>
        <span class="txt">${item.type === 'shop'
          ? '<b>店铺异常</b>：' + esc(item.start) + ' ~ ' + esc(item.end) + (dur ? '（' + esc(dur) + '）' : '')
          : '商品 ' + esc(item.productId) + (item.title ? '（' + esc(item.title) + '）' : '') + '：' + esc(item.start) + ' ~ ' + esc(item.end) + (dur ? '（' + esc(dur) + '）' : '')}</span>
      </div>`);
    }
  }
  if (!lines.length) {
    box.innerHTML = '<div class="empty">暂无异常持续记录（所有商品/店铺最近均正常）</div>';
    return;
  }
  box.innerHTML = lines.join('');
}

function addShop() {
  const key = 'shop' + String(state.shops.length + 1).padStart(2, '0') + '_' + Date.now().toString(36).slice(-4);
  state.shops.push({ key, name: '', profileDir: '', activityUrl: '', account: '', password: '', hasPassword: false, chromeDebugPort: 0, enabled: true, verifyShopName: true, products: [] });
  renderShops();
}

// 活动名称一键通用：同期大多是同一个活动，一次填到所有商品。
function applyActivityNameAll() {
  const name = document.getElementById('globalActivityName').value.trim();
  if (!name) { alert('请先在输入框里填要通用的活动名称'); return; }
  let count = 0;
  state.shops.forEach((shop) => (shop.products || []).forEach((p) => { p.activityName = name; count += 1; }));
  if (!count) { alert('还没有任何商品'); return; }
  renderShops();
  alert(`已把活动名称「${name}」应用到全部 ${count} 个商品，记得点「保存全部修改」。`);
}

// 活动页URL一键通用：只填到各店铺的「活动报名记录页 URL」栏（店铺层面），不写每个商品的单独链接。
function applyActivityUrlAll() {
  const url = document.getElementById('globalActivityUrl').value.trim();
  if (!url) { alert('请先在输入框里填要通用的活动报名记录页URL'); return; }
  if (!state.shops.length) { alert('还没有任何店铺'); return; }
  state.shops.forEach((shop) => { shop.activityUrl = url; });
  renderShops();
  alert(`已把活动报名记录页URL应用到全部 ${state.shops.length} 个店铺，记得点「保存全部修改」。`);
}

// 一键恢复超级立减活动网址（单次确认）
async function restoreSuperDealUrls() {
  if (!state.shops.length) { alert('还没有任何店铺'); return; }

  const shopCount = state.shops.length;
  const ok = confirm(
    '将把全部 ' + shopCount + ' 个店铺的「活动报名记录页URL」\n' +
    '一键恢复为超级立减活动网址。\n\n' +
    '（仅修改店铺的活动报名记录页URL，不影响商品监控数据）\n\n' +
    '点击「确定」执行，点击「取消」放弃。'
  );
  if (!ok) return;

  const btn = document.querySelector('button[onclick="restoreSuperDealUrls()"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/restore-super-deal-urls', { method: 'POST', body: '{}' });
    if (res && res.ok) {
      alert('✅ ' + (res.message || '恢复完成'));
      await loadConfig();
    } else {
      alert('❌ 恢复失败：' + ((res && res.error) || '未知错误'));
    }
  } catch (err) {
    alert('❌ 恢复失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 只应用到某个店铺的全部商品。
function applyActivityNameToShop(i) {
  const shop = state.shops[i];
  if (!shop.products.length) { alert('该店铺还没有商品'); return; }
  const current = ((shop.products.find((p) => p.activityName) || {}).activityName) || '';
  const name = prompt('输入要应用到本店全部商品的活动名称：', current);
  if (name === null) return;
  const trimmed = name.trim();
  shop.products.forEach((p) => { p.activityName = trimmed; });
  renderShops();
}

function addProduct(i) {
  state.shops[i].products.push({
    productId: '', productName: '', activityName: '', activityUrl: '', activityDeadline: '', owner: '', monitorMode: 'added_time', monitorSince: '',
    monitorActivityKeywords: '', recoveryActivityKeywords: '', recoveryGraceMinutes: 0,
    expectedPrice: 0, minStock: 0, priceTolerance: 0.01, enabled: true,
  });
  renderShops();
}

function removeProduct(btn, i, j) {
  const p = state.shops[i].products[j] || {};
  // 第一次点击：进入确认状态（按钮变实心红，3秒内再次点击才删除）
  if (!btn.dataset.arm) {
    btn.dataset.arm = '1';
    btn.textContent = '确认删除？';
    btn.style.background = '#c0392b';
    btn.style.color = '#fff';
    btn.style.fontWeight = 'bold';
    setTimeout(() => {
      if (btn && btn.isConnected) {
        btn.dataset.arm = '';
        btn.textContent = '删除';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.fontWeight = '';
      }
    }, 3000);
    return;
  }
  // 第二次点击：真正删除
  if (!confirm(`确定删除这条监控链接？\n商品ID：${p.productId || '未填写'}\n活动名称：${p.activityName || '未填写'}\n删除后点「保存全部修改」生效，该商品将不再检测。`)) return;
  state.shops[i].products.splice(j, 1);
  document.getElementById('saveState').textContent = '有未保存的修改';
  renderShops();
}

function onField(input) {
  const i = Number(input.dataset.shop);
  const j = input.dataset.product === undefined ? -1 : Number(input.dataset.product);
  const field = input.dataset.field;
  const value = input.type === 'checkbox' ? input.checked : input.value;
  if (j >= 0) state.shops[i].products[j][field] = value;
  else state.shops[i][field] = value;
  document.getElementById('saveState').textContent = '有未保存的修改';
}

function field(labelText, html, wide) {
  return `<label class="field${wide ? ' wide' : ''}">${labelText}${html}</label>`;
}

// 展开/收起状态（页面内保留，刷新后重置为收起）
const expandedShops = new Set();

function toggleShop(i) {
  const body = document.getElementById('shopBody-' + i);
  if (!body) return;
  const nowHidden = body.classList.toggle('hidden');
  if (nowHidden) expandedShops.delete(i); else expandedShops.add(i);
  const arrow = document.getElementById('shopArrow-' + i);
  if (arrow) { arrow.textContent = nowHidden ? '▸' : '▾'; arrow.classList.toggle('popped', nowHidden); }
}

// 商品低频字段（活动页URL/截止时间/监控开始时间/监控模式）用弹窗编辑，保持表格简洁。
let editingDetail = null; // { i, j }
function editProductDetail(i, j) {
  const p = (state.shops[i] && state.shops[i].products[j]) || {};
  editingDetail = { i, j };
  document.getElementById('mdTitle').textContent = `商品设置：${p.productName || p.productId || '(未填写名称)'}`;
  document.getElementById('mdActivityUrl').value = p.activityUrl || '';
  document.getElementById('mdDeadline').value = p.activityDeadline || '';
  document.getElementById('mdMonitorSince').value = p.monitorSince || '';
  document.getElementById('mdMonitorMode').value = p.monitorMode === 'signup_date' ? 'signup_date' : 'added_time';
  document.getElementById('productDetailModal').classList.remove('hidden');
}
function saveProductDetail() {
  if (!editingDetail) return;
  const p = state.shops[editingDetail.i].products[editingDetail.j];
  p.activityUrl = document.getElementById('mdActivityUrl').value;
  p.activityDeadline = document.getElementById('mdDeadline').value;
  p.monitorSince = document.getElementById('mdMonitorSince').value;
  p.monitorMode = document.getElementById('mdMonitorMode').value;
  document.getElementById('saveState').textContent = '有未保存的修改';
  document.getElementById('productDetailModal').classList.add('hidden');
  editingDetail = null;
}
function closeProductDetail() {
  document.getElementById('productDetailModal').classList.add('hidden');
  editingDetail = null;
}

function renderShops() {
  const box = document.getElementById('shopList');
  if (!state.shops.length) {
    box.innerHTML = '<div class="empty">还没有店铺，点击上方「+ 添加店铺」开始。</div>';
    return;
  }
  box.innerHTML = state.shops.map((shop, i) => {
    const bodyOpen = expandedShops.has(i);
    const products = shop.products || [];
    return `
    <div class="shop-card">
      <div class="shop-head" onclick="toggleShop(${i})" title="点击展开/收起">
        <span class="arrow${bodyOpen ? '' : ' popped'}" id="shopArrow-${i}">${bodyOpen ? '▾' : '▸'}</span>
        <strong>${esc(shop.name) || '(未命名店铺)'}</strong>
        <span class="key">编号：${esc(shop.key)}</span>
        <span class="badge ${shop.enabled ? 'badge-on' : 'badge-off'}">${shop.enabled ? '已启用' : '已停用'}</span>
        <span class="muted">商品 ${products.length} 个</span>
        <button class="btn-detect head-btn" onclick="event.stopPropagation(); runShopDetect('${esc(shop.key)}', this)" title="只检测本店铺，不影响其他店铺">检测此店铺</button>
      </div>
      <div class="shop-body${bodyOpen ? '' : ' hidden'}" id="shopBody-${i}">
        <div class="row">
          ${field('店铺编号（字母数字，保存后不要改）', `<input type="text" data-shop="${i}" data-field="key" value="${esc(shop.key)}" oninput="onField(this)">`)}
          ${field('店铺名称（与后台显示一致，不带【】）', `<input type="text" data-shop="${i}" data-field="name" value="${esc(shop.name)}" oninput="onField(this)">`)}
          ${field('活动报名记录页 URL', `<input type="text" data-shop="${i}" data-field="activityUrl" value="${esc(shop.activityUrl)}" placeholder="https://..." oninput="onField(this)">`, true)}
          ${field('登录 profile 目录（cdp 模式留空）', `<input type="text" data-shop="${i}" data-field="profileDir" value="${esc(shop.profileDir)}" oninput="onField(this)">`)}
        </div>
        <div class="row">
          ${field('登录账号（掉线自动重登用，可选）', `<input type="text" data-shop="${i}" data-field="account" value="${esc(shop.account || '')}" placeholder="淘宝/天猫账号" oninput="onField(this)">`)}
          ${field('登录密码（留空=保持不变）', `<input type="password" data-shop="${i}" data-field="password" value="" placeholder="${shop.hasPassword ? '已设置，留空保持不变' : '未设置'}" oninput="onField(this)">`)}
          ${field('调试端口（多店铺各不同，0=自动）', `<input type="number" data-shop="${i}" data-field="chromeDebugPort" value="${shop.chromeDebugPort || 0}" min="0" max="65535" oninput="onField(this)">`)}
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" data-shop="${i}" data-field="enabled" ${shop.enabled ? 'checked' : ''} onchange="onField(this)"> 启用该店铺</label>
          <label class="check"><input type="checkbox" data-shop="${i}" data-field="verifyShopName" ${shop.verifyShopName !== false ? 'checked' : ''} onchange="onField(this)"> 校验店铺名（防串店）</label>
        </div>
        <table class="shop-table">
          <colgroup>
            <col style="width:16%"><col style="width:18%"><col style="width:26%"><col style="width:22%"><col style="width:12%"><col style="width:6%">
          </colgroup>
          <thead><tr>
            <th>操作</th><th>商品ID</th><th>商品标题</th><th>活动名称</th><th>负责人</th><th>启用</th>
          </tr></thead>
          <tbody>
            ${products.map((p, j) => `
              <tr>
                <td>
                  <button class="btn-plain btn-mini" onclick="editProductDetail(${i},${j})" title="设置活动页URL、截止时间、监控开始时间、监控模式">设置</button>
                  <button class="btn-danger btn-mini" onclick="removeProduct(this,${i},${j})" title="点击一次进入确认状态，再次点击才真正删除">删除</button>
                </td>
                <td><input type="text" data-shop="${i}" data-product="${j}" data-field="productId" value="${esc(p.productId)}" oninput="onField(this)"></td>
                <td><input type="text" data-shop="${i}" data-product="${j}" data-field="productName" value="${esc(p.productName)}" oninput="onField(this)"></td>
                <td><input type="text" data-shop="${i}" data-product="${j}" data-field="activityName" value="${esc(p.activityName)}" placeholder="如：天猫新势力周" oninput="onField(this)"></td>
                <td><input type="text" data-shop="${i}" data-product="${j}" data-field="owner" value="${esc(p.owner)}" oninput="onField(this)"></td>
                <td style="text-align:center"><input type="checkbox" data-shop="${i}" data-product="${j}" data-field="enabled" ${p.enabled !== false ? 'checked' : ''} onchange="onField(this)"></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="row" style="margin-top:10px;margin-bottom:0;">
          <button class="btn-plain btn-mini" onclick="addProduct(${i})">+ 添加商品</button>
          <button class="btn-plain btn-mini" onclick="applyActivityNameToShop(${i})" title="把同一个活动名称一次填到本店全部商品">活动名称本店通用</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// 下载导入模板：必须带管理口令请求头（window.open 直接跳转带不上，会被口令拦截返回 JSON 错误页）。
async function downloadTemplate() {
  try {
    const res = await fetch('/api/template', {
      headers: { 'X-Admin-Token': encodeURIComponent(localStorage.getItem('adminToken') || '') },
    });
    if (res.status === 401) {
      const token = prompt('该管理后台已设置口令，请输入管理口令：');
      if (token === null) return;
      localStorage.setItem('adminToken', token.trim());
      return downloadTemplate();
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '商品导入模板.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (error) {
    alert('模板下载失败：' + error.message);
  }
}

async function importExcel(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const el = document.getElementById('saveState');
  el.textContent = '正在导入 ' + file.name + ' ...';
  el.style.display = '';
  try {
    const data = await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    let text = `导入完成：新增店铺 ${data.shopsAdded} 个，新增商品 ${data.productsAdded} 个，更新商品 ${data.productsUpdated} 个。`;
    if (data.errors && data.errors.length) text += '\n\n以下行被跳过：\n' + data.errors.join('\n');
    alert(text);
    el.textContent = '';
    el.style.display = 'none';
    showToast('导入成功 ' + new Date().toLocaleTimeString('zh-CN'));
    await loadConfig();
  } catch (error) {
    el.textContent = '';
    alert('导入失败：' + error.message);
  }
}

async function saveAll() {
  // 必须先选择花名（操作人）才能保存：保证操作日志可追溯。
  const opValue = document.getElementById('operatorInput').value;
  if (!opValue) {
    showToast('⚠️ 请先选择花名（操作人），选择后才能保存修改。');
    return;
  }
  localStorage.setItem('operatorName', opValue);
  const el = document.getElementById('saveState');
  el.textContent = '';
  el.style.display = 'none';
  showToast('正在保存...');
  try {
    const ownerPhones = parseOwnerPhonesInput();
    // 本地校验：店铺内商品 ID 唯一（重复会干扰检测去重、条数统计与异常标记），先拦截再提交。
    const dupReports = [];
    for (const shop of state.shops) {
      const seen = new Set();
      const dups = new Set();
      for (const p of (shop.products || [])) {
        const id = String(p.productId || '').trim();
        if (!id) continue;
        if (seen.has(id)) dups.add(id); else seen.add(id);
      }
      if (dups.size) dupReports.push(`${shop.name || shop.key}：${[...dups].join('、')}`);
    }
    if (dupReports.length) {
      showToast('❌ 店铺内商品 ID 重复，未保存：' + dupReports.join('；') + '。请先删除重复行再保存。');
      return;
    }
    const intervalMinutes = Math.max(1, Math.min(1440, parseInt(document.getElementById('intervalInput').value, 10) || 30));
    const repeatRaw = parseInt(document.getElementById('repeatInput').value, 10);
    const anomalyRepeatMinutes = Number.isNaN(repeatRaw) ? 30 : Math.max(0, Math.min(1440, repeatRaw));
    // 免打扰时段：开始/结束都要选或都留空；拼成 "HH:MM-HH:MM" 提交（后端格式不变）
    const quietStart = document.getElementById('quietStart').value;
    const quietEnd = document.getElementById('quietEnd').value;
    if ((quietStart && !quietEnd) || (!quietStart && quietEnd)) {
      showToast('⚠️ 免打扰时段的开始和结束时间都要选择，或都留空（不启用）。');
      return;
    }
    const quietHours = (quietStart && quietEnd) ? quietStart + '-' + quietEnd : '';
    const res = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shops: state.shops, ownerPhones, intervalMinutes, anomalyRepeatMinutes,
        quietHours,
        dailyReportEnabled: document.getElementById('reportEnabled').checked,
        dailyReportTime: document.getElementById('reportTime').value || '21:00',
        dailyReportDingTalk: document.getElementById('reportDingEnabled').checked,
        autoRestartEnabled: document.getElementById('restartEnabled').checked,
        autoRestartTime: document.getElementById('restartTime').value || '04:00',
        baseUpdatedAt: state.updatedAt,
      }),
    });
    el.textContent = '';
    el.style.display = 'none';
    if (res && res.unchanged) {
      showToast('配置无任何修改，未重复保存。');
      return;
    }
    // 计划任务同步结果只提示失败项（成功结果与日志一致，不显示，避免每次保存都重复“日报/重启 已启用”）。
    const schedFailures = (res && res.scheduleResult || []).filter((r) => /失败|格式不对/.test(r));
    const sched = schedFailures.length ? '；自动任务：' + schedFailures.join('、') : '';
    showToast('已保存 ' + new Date().toLocaleTimeString('zh-CN') + sched);
    await loadConfig();
  } catch (error) {
    el.textContent = '';
    el.style.display = 'none';
    if (/其他人修改|冲突/.test(error.message)) {
      alert(error.message);
      await loadConfig();
    } else {
      alert('保存失败：' + error.message);
    }
  }
}

async function runOnce() {
  const shopCount = (state.shops || []).length;
  if (!confirm(`确定立即检测全部 ${shopCount} 个店铺吗？\n\n提示：每次全量检测都会重新登录店铺，频繁触发可能增加风控概率（登录态失效）。平时让定时（${document.getElementById('intervalInput').value || 30} 分钟）自动检测即可。`)) return;
  const btn = document.getElementById('btnRunOnce');
  const cancelBtn = document.getElementById('btnRunCancel');
  const el = document.getElementById('runState');
  btn.disabled = true;
  cancelBtn.classList.remove('hidden');
  el.textContent = '检测中，通常需要几分钟；点「取消检测」可随时中止...';
  try {
    const res = await api('/api/run-once', { method: 'POST' });
    el.textContent = '检测完成';
    if (res && res.concurrent && res.monitorHint) {
      el.textContent = '检测完成（注意：自动巡检进程也在运行，并发时结果以最后写入为准）';
      setTimeout(() => { el.textContent = '检测完成'; }, 15000);
    }
  } catch (error) {
    el.textContent = /取消/.test(error.message) ? '检测已取消' : '检测结束（有错误，见下方日志）';
  } finally {
    btn.disabled = false;
    cancelBtn.classList.add('hidden');
    loadResults();
  }
}

// 中止正在运行的手动检测（误点「立即检测一次」时用）。
async function cancelRun() {
  const btn = document.getElementById('btnRunCancel');
  btn.disabled = true;
  try {
    const res = await api('/api/run-cancel', { method: 'POST' });
    document.getElementById('runState').textContent = res.ok ? '正在取消...' : '当前没有正在运行的手动检测';
  } catch (error) {
    alert('取消失败：' + error.message);
  } finally {
    btn.disabled = false;
  }
}

// 只检测指定店铺（店铺卡片上的「检测此店铺」按钮）。
async function runShopDetect(shopKey, btn) {
  if (!confirm(`确定只检测店铺「${shopKey}」吗？其他店铺本轮不受影响。`)) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检测中...';
  try {
    const res = await api('/api/run-shop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopKey }) });
    alert(res && res.concurrent && res.monitorHint ? '检测完成。注意：自动巡检进程也在运行，两个进程并发时 Chrome 标签页与结果文件可能互相影响，以最后写入的结果为准。' : '检测完成，请到「检测结果」页查看。');
  } catch (error) {
    alert('检测结束（有错误）：' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// 停止/恢复自动检测。
async function refreshPauseButton() {
  try {
    const data = await api('/api/monitor-state');
    const btn = document.getElementById('btnPauseToggle');
    btn.textContent = data.paused ? '恢复自动检测' : '停止自动检测';
    btn.className = data.paused ? 'btn-primary' : 'btn-danger';
    btn.title = data.paused ? '当前已暂停，点击恢复按间隔自动巡检' : '暂停按间隔的自动巡检（手动「立即检测」不受影响）';
  } catch (_) {}
}

async function togglePause() {
  const btn = document.getElementById('btnPauseToggle');
  const pausing = btn.textContent.indexOf('停止') >= 0;
  if (pausing && !confirm('确定停止自动检测吗？停止后不再按间隔巡检，直到点「恢复自动检测」。')) return;
  btn.disabled = true;
  try {
    const data = await api('/api/monitor-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: pausing }) });
    alert(data.paused ? '已停止自动检测（监控程序仍在运行，只是暂停巡检）。' : '已恢复自动检测。');
  } catch (error) {
    alert('操作失败：' + error.message);
  } finally {
    btn.disabled = false;
    refreshPauseButton();
  }
}

// 记录日志查看模式（true=原始 / false=精简）
let logModeRaw = false;

function toggleLogMode() {
  logModeRaw = !logModeRaw;
  const btn = document.getElementById('btnLogToggle');
  btn.textContent = logModeRaw ? '查看精简日志' : '查看原始日志';
  document.getElementById('logLines').classList.toggle('hidden', logModeRaw);
  document.getElementById('logTail').classList.toggle('hidden', !logModeRaw);
}

// 导出最近一小时检测日志
async function exportLog() {
  try {
    const res = await fetch('/api/export-log?minutes=60', {
      headers: { 'X-Admin-Token': encodeURIComponent(localStorage.getItem('adminToken') || '') },
    });
    if (res.status === 401) {
      const token = prompt('该管理后台已设置口令，请输入管理口令：');
      if (token === null) return;
      localStorage.setItem('adminToken', token.trim());
      return exportLog();
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '_' + pad(now.getHours()) + '-' + pad(now.getMinutes());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '监控日志-最近30分钟-' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (error) {
    alert('导出失败：' + error.message);
  }
}

// 渲染精简日志（分级着色 + 店铺标签 + 截断JSON）
let logAtBottom = true; // 用户是否停留在列表底部（新日志自动跟随；上滑查看历史时暂停跟随）
function renderLogLines(lines) {
  const box = document.getElementById('logLines');
  if (!box._logScrollBound) {
    box._logScrollBound = true;
    box.addEventListener('scroll', () => {
      logAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    });
  }
  if (!lines || !lines.length) { box.innerHTML = '<div class="empty">（暂无日志）</div>'; return; }
  // 按出现顺序给店铺分配颜色，相邻不同店铺用不同色（蓝/黄/绿/青循环）
  const shopColor = {};
  let colorIdx = 0;
  const colorFor = (name) => {
    if (!(name in shopColor)) { shopColor[name] = 'c' + (colorIdx % 4); colorIdx++; }
    return shopColor[name];
  };
  box.innerHTML = lines.map((l) => `
    <div class="log-item">
      <span class="lt">${esc(l.time)}</span>
      <span class="lvl lvl-${esc(l.level)}">${esc(l.level)}</span>
      ${l.shop ? `<span class="shop-tag ${colorFor(l.shop)}">${esc(l.shop)}</span>` : ''}
      <span class="txt">${esc(l.text)}</span>
    </div>`).join('');
  // 停留在底部时自动滚到最新日志，不用手动下滑
  if (logAtBottom) box.scrollTop = box.scrollHeight;
}

// 渲染操作日志
// 操作类型 → 颜色（操作日志美观配色）
const OP_COLORS = {
  '保存配置': '#1e8e3e',
  '导入配置': '#0f8f6f',
  '恢复超级立减网址': '#b7791f',
};
// 店铺调色板：按店铺出现顺序分配颜色（同一店铺颜色稳定，不同店铺不重复；全部避开红色系，红色留给错误/删除）
const SHOP_PALETTE = ['#3370ff', '#00a870', '#722ed1', '#d48806', '#13a8a8', '#13c2c2', '#fa8c16', '#2f54eb', '#a0d911', '#531dab'];
const shopColorMap = new Map();
let shopColorCursor = 0;
function shopColor(name) {
  if (!shopColorMap.has(name)) {
    shopColorMap.set(name, SHOP_PALETTE[shopColorCursor % SHOP_PALETTE.length]);
    shopColorCursor++;
  }
  return shopColorMap.get(name);
}
// 商品/店铺操作动词 → 颜色
const ACT_COLORS = { '新增商品': '#00a870', '删除商品': '#d54941', '修改商品': '#d48806', '新增店铺': '#00a870', '删除店铺': '#d54941', '修改店铺': '#d48806' };
// 片段渲染：店铺名 / 操作动词 / 剩余内容 三列布局，上下行对齐
function colorizeSeg(p) {
  if (!p.shop && !p.act) return `<div class="op-seg">${esc(p.seg)}</div>`;
  let rest = p.seg;
  if (p.shop) rest = rest.replace(p.shop, '');
  if (p.act) rest = rest.replace(p.act, '');
  rest = rest.trim();
  const shopHtml = p.shop ? `<span class="op-shop" style="color:${shopColor(p.shop)}">${esc(p.shop)}</span>` : '<span class="op-shop"></span>';
  const actHtml = (p.act && ACT_COLORS[p.act]) ? `<span class="op-act" style="color:${ACT_COLORS[p.act]}">${esc(p.act)}</span>` : `<span class="op-act">${esc(p.act)}</span>`;
  return `<div class="op-seg">${shopHtml}${actHtml}<span class="op-rest">${esc(rest)}</span></div>`;
}
// 详情按「；」拆行：店铺名着色 + 操作动词着色；同一店铺连续多条操作只显示一次店铺名
function renderDetailLines(detail) {
  if (!detail) return '';
  const parts = String(detail).split(/[；;]/).map((s) => s.trim()).filter(Boolean).map((seg) => {
    const shopMatch = seg.match(/([\u4e00-\u9fa5A-Za-z0-9]+?(?:旗舰店|专营店|专卖店))/);
    const actMatch = seg.match(/(新增商品|删除商品|修改商品|新增店铺|删除店铺|修改店铺)/);
    return { seg, shop: shopMatch ? shopMatch[1] : '', act: actMatch ? actMatch[1] : '' };
  });
  const out = [];
  let prevShop = '';
  for (const p of parts) {
    if (p.shop && p.shop === prevShop && p.seg.startsWith(p.shop)) {
      // 同一店铺的后续操作：省略店铺名，店铺列留空占位以对齐
      out.push(colorizeSeg({ seg: p.seg.slice(p.shop.length).trim(), shop: '', act: p.act }));
    } else {
      out.push(colorizeSeg(p));
      prevShop = p.shop;
    }
  }
  return out.join('');
}
function renderOperations(ops) {
  const box = document.getElementById('opLogList');
  if (!ops || !ops.length) { box.innerHTML = '<div class="empty">暂无操作记录</div>'; return; }
  box.innerHTML = ops.map((line) => {
    // 新格式：[时间] [花名] 操作 - 详情；旧格式：[时间] 操作 - 详情 或 时间 操作 详情
    let m = line.match(/^\[([^\]]+)\]\s*(?:\[([^\]]+)\])?\s*([^\s]+)(?:\s*-\s*(.*))?$/);
    let opName = '', detail = '', operator = '', time = '';
    if (m) {
      time = m[1]; operator = m[2] || ''; opName = m[3] || ''; detail = m[4] || '';
    } else {
      const m2 = line.match(/^\[?(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2} \d{1,2}:\d{2}:\d{2})\]?\s+([^\s]+)(?:\s+(.*))?$/);
      if (m2) { time = m2[1]; opName = m2[2] || ''; detail = m2[3] || ''; m = [null]; }
    }
    if (!m) return `<div class="op-item"><span class="od">${esc(line)}</span></div>`;
    const color = OP_COLORS[opName] || '#1f6fd6';
    const opTag = operator ? `<span class="oo">${esc(operator)}</span>` : '';
    return `<div class="op-item"><span class="ot">${esc(time)}</span>${opTag}<span class="oa" style="color:${color}">${esc(opName)}</span><span class="od">${renderDetailLines(detail)}</span></div>`;
  }).join('');
}

let opLoadLimit = 50;
let opDateFilter = '';
async function loadOperations() {
  try {
    const qs = '?limit=' + opLoadLimit + (opDateFilter ? '&date=' + encodeURIComponent(opDateFilter) : '');
    const data = await api('/api/operations' + qs);
    const ops = data.operations || [];
    renderOperations(ops);
    const moreBtn = document.getElementById('opMore');
    if (moreBtn) moreBtn.classList.toggle('hidden', ops.length < opLoadLimit);
    const countEl = document.getElementById('opCount');
    if (countEl) countEl.textContent = opDateFilter ? `共 ${ops.length} 条（${opDateFilter}）` : `共 ${ops.length} 条（最近）`;
  } catch (_) {}
}

// 按店铺分组渲染检测结果，可折叠
// 按店铺分组渲染检测结果，可折叠；异常店铺默认展开、正常店铺收起；异常商品置顶
function renderResultGroups(results) {
  const box = document.getElementById('resultTable');
  const rows = results.results || [];
  if (!rows.length) { box.innerHTML = '<div class="empty">本轮没有商品检测结果（可能店铺异常，见日志）。</div>'; return; }
  const byShop = {};
  const shopMeta = {};
  (results.shops || []).forEach((s) => { shopMeta[s.key] = s; });
  rows.forEach((r) => {
    const key = r.shopKey || r.shopName || '未知';
    if (!byShop[key]) byShop[key] = { name: r.shopName || key, items: [] };
    byShop[key].items.push(r);
  });
  box.innerHTML = Object.values(byShop).map((group) => {
    const meta = shopMeta[group.items[0].shopKey] || {};
    const anomalyCount = group.items.filter((r) => r.isAnomaly || r.error).length;
    const badge = anomalyCount ? '<span class="badge badge-off">异常 ' + anomalyCount + '</span>' : '<span class="badge badge-on">正常</span>';
    // 异常商品排在最前
    const sorted = group.items.slice().sort((a, b) => {
      const aa = (a.isAnomaly || a.error) ? 0 : 1;
      const bb = (b.isAnomaly || b.error) ? 0 : 1;
      return aa - bb;
    });
    // 有异常（商品或店铺错误）默认展开，正常店铺默认收起；异常店铺组加炫酷警示样式
    const defaultCollapsed = (anomalyCount === 0 && !meta.error) ? ' collapsed' : '';
    const alarmGroup = (anomalyCount > 0 || meta.error) ? ' alarm-group' : '';
    return `
      <div class="shop-group${alarmGroup}">
        <div class="shop-group-head${defaultCollapsed}" onclick="toggleShopGroup(this)">
          <span class="arrow">▼</span>
          <strong>${esc(group.name)}</strong>
          ${meta.error ? `<span class="badge badge-off" title="${esc(meta.error)}">店铺异常</span>` : ''}
          ${badge}
          <span class="muted">商品 ${group.items.length} 条</span>
        </div>
        <div class="shop-group-body${defaultCollapsed}">
          <table>
            <thead><tr><th>商品ID</th><th>商品标题</th><th>活动名称</th><th>负责人</th><th>状态</th></tr></thead>
            <tbody>
              ${sorted.map((r) => `
                <tr${(r.isAnomaly || r.error) ? ' class="tr-alarm"' : ''}>
                  <td>${esc(r.productId)}</td>
                  <td>${esc(r.productName)}</td>
                  <td>${esc(r.activityName || r.activityTitle || '')}</td>
                  <td>${esc(r.owner)}</td>
                  <td class="${r.isAnomaly ? 'status-alarm' : (r.error ? 'status-alarm' : 'status-ok')}">${esc(r.statusText || r.error || '')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

// 点击店铺分组头：展开/收起
function toggleShopGroup(head) {
  head.classList.toggle('collapsed');
  const body = head.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

async function loadResults() {
  try {
    const data = await api('/api/results');
    // 精简日志
    renderLogLines(data.logLines || []);
    document.getElementById('logTail').textContent = data.logTail || '（暂无日志）';
    // 操作日志由「信息看板」页的 /api/operations 独立加载，此处不再重复拉取。
    const results = data.results;
    if (!results) {
      document.getElementById('resultSummary').innerHTML = '<div class="empty">还没有检测记录，点击「立即检测一次」。</div>';
      document.getElementById('resultTable').innerHTML = '';
      return;
    }
    const shops = results.shops || [];
    const shopErrors = shops.filter((s) => s.error);
    const okCount = shops.filter((s) => !s.error).length;
    const summaryHtml = `
      <div class="stat-grid">
        <div class="stat-cell"><div class="k">最近检测时间</div><div class="v" style="font-size:15px;font-weight:500;">${esc(results.time || '')}</div></div>
        <div class="stat-cell"><div class="k">店铺总数</div><div class="v"><span class="num" data-count="${shops.length}">0</span></div></div>
        <div class="stat-cell"><div class="k">正常</div><div class="v green"><span class="num" data-count="${okCount}">0</span></div></div>
        <div class="stat-cell"><div class="k">异常</div><div class="v red${shopErrors.length ? ' num-alarm' : ''}"><span class="num" data-count="${shopErrors.length}">0</span></div></div>
      </div>
      ${shopErrors.length ? `<div style="margin-bottom:14px;padding:12px 16px;background:#fdecec;border-radius:8px;font-size:12px;line-height:1.8;color:#c0392b;">${shopErrors.map((s) => `<div><b>${esc(s.name)}</b>：${esc(s.error)}</div>`).join('')}</div>` : ''}`;
    document.getElementById('resultSummary').innerHTML = summaryHtml;
    // 汇总数字滚动动画
    document.querySelectorAll('#resultSummary .num[data-count]').forEach((el) => animateNumber(el, Number(el.dataset.count) || 0));
    renderResultGroups(results);
  } catch (error) {
    document.getElementById('resultSummary').innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`;
  }
}

// 花名（操作人）：下拉选项来自商品负责人 + 负责人手机号映射；选择后保存到本地，操作日志记录操作人。
function saveOperator() {
  const el = document.getElementById('operatorInput');
  const v = el.value || '';
  localStorage.setItem('operatorName', v);
  if (v) showToast('花名已设置：' + v);
}
function initOperator() {
  const el = document.getElementById('operatorInput');
  const saved = localStorage.getItem('operatorName') || '';
  const owners = new Set();
  (state.shops || []).forEach((shop) => (shop.products || []).forEach((p) => { if (String(p.owner || '').trim()) owners.add(String(p.owner).trim()); }));
  Object.keys(state.ownerPhones || {}).forEach((name) => { if (name.trim()) owners.add(name.trim()); });
  el.innerHTML = '<option value="" disabled selected hidden>请选择花名</option>' + [...owners].map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  if (saved && owners.has(saved)) el.value = saved;
  localStorage.setItem('operatorName', el.value || '');
}

// 默认进入检测总览
// 注意：花名下拉由 loadConfig 成功后的 initOperator() 初始化（提前初始化会因店铺还没加载而清空已保存的花名）。
loadConfig().catch((error) => alert('加载配置失败：' + error.message));