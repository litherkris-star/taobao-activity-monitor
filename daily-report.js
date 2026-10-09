'use strict';
// 每日检测简报：统计 logs/monitor.log 当天（00:00 至今）的检测情况，写入 data/daily-reports.json 供后台「信息看板」展示（不再发钉钉）。
// 手动运行：node daily-report.js   计划任务：每天按配置时间自动运行。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_PATH = path.join(ROOT, 'logs', 'monitor.log');
const REPORT_PATH = path.join(ROOT, 'data', 'daily-reports.json');
const MAX_DAYS = 30; // 看板保留最近 30 天日报
const { sendNotification, hasNotificationChannel } = require('./notifier'); // 钉钉推送为可选开关

function localNow() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function todayPrefix() {
  return localNow().slice(0, 10);
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (error) {
    throw new Error(`读取日志失败：${error.message || error}`);
  }
  const prefix = todayPrefix();
  const lines = raw.split('\n').filter((line) => line.startsWith(`[${prefix}`));

  let cycleCount = 0;                 // 检测轮数（多店铺检测完成）
  let alertCount = 0;                 // 商品报警次数（报警发送成功）
  let alertProductSum = 0;            // 报警商品累计数
  let recoveryCount = 0;              // 商品恢复个数
  let loginFailCount = 0;             // 登录失败次数（直接登录失败/登录状态已失效）
  const shopFail = {};                // 各店铺失败次数（ERROR [店铺名]）
  const shopRun = {};                 // 各店铺开始检测次数
  const serviceRecovered = [];        // 服务自动恢复

  for (const line of lines) {
    if (line.includes('多店铺检测完成')) {
      cycleCount += 1;
    } else if (line.includes('报警发送成功')) {
      alertCount += 1;
      const m = line.match(/报警发送成功：(\d+) 个商品活动异常/);
      if (m) alertProductSum += Number(m[1]);
    } else if (line.includes('商品已恢复正常')) {
      const m = line.match(/商品已恢复正常（[^）]*）：(.+)/);
      if (m) recoveryCount += (m[1] || '').split('、').filter(Boolean).length;
    } else if (line.includes('直接登录失败') || line.includes('登录状态已失效')) {
      loginFailCount += 1;
    } else if (line.includes('服务自动恢复已记录到信息看板')) {
      const m = line.match(/服务自动恢复已记录到信息看板：(.+)。/);
      if (m) serviceRecovered.push(m[1]);
    }
    const shopMatch = line.match(/\[ERROR\] \[(.+?)\]/);
    if (shopMatch) shopFail[shopMatch[1]] = (shopFail[shopMatch[1]] || 0) + 1;
    const runMatch = line.match(/\[INFO\] \[(.+?)\] 开始检测 \d+ 个商品/);
    if (runMatch) shopRun[runMatch[1]] = (shopRun[runMatch[1]] || 0) + 1;
  }

  const failLines = Object.entries(shopFail)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `- ${name}：失败 ${count} 次`)
    .join('\n') || '无';
  const runLines = Object.entries(shopRun)
    .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    .map(([name, count]) => `${name} ${count} 轮`)
    .join('、') || '无';

  const dateLabel = localNow().slice(0, 10);
  // 检测间隔从 config.json 读取（默认 30 分钟），避免日报里写死数字与当前配置不一致。
  let intervalMinutes = 30;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (Number(cfg.intervalMinutes) > 0) intervalMinutes = Number(cfg.intervalMinutes);
  } catch (_) {}
  const markdown = [
    `### 淘宝活动监控日报（${dateLabel}）`,
    ``,
    `**今日检测**：${cycleCount} 轮（间隔 ${intervalMinutes} 分钟）`,
    `**商品活动异常报警**：${alertCount} 次 / 累计 ${alertProductSum} 个商品`,
    `**商品恢复正常**：${recoveryCount} 个`,
    `**登录失败（风控拦截）**：${loginFailCount} 次`,
    `**店铺检测失败**：${Object.values(shopFail).reduce((a, b) => a + b, 0)} 家次`,
    ``,
    `**各店铺失败明细**：`,
    `${failLines}`,
    ``,
    `**各店铺检测轮数**：${runLines}`,
    serviceRecovered.length ? `\n**服务自动恢复**：${serviceRecovered.join('、')}` : '',
  ].filter(Boolean).join('\n');

  console.log(`检测轮数: ${cycleCount}`);
  console.log(`报警次数: ${alertCount}（${alertProductSum} 个商品）`);
  console.log(`恢复个数: ${recoveryCount}`);
  console.log(`登录失败: ${loginFailCount}`);
  console.log(`店铺失败: ${JSON.stringify(shopFail)}`);

  // 写入信息看板文件（按日期覆盖，同一天重复运行只保留最新一份；保留最近 30 天）
  const entry = {
    date: dateLabel,
    generatedAt: localNow(),
    markdown,
    cycleCount,
    alertCount,
    alertProductSum,
    recoveryCount,
    loginFailCount,
    shopFailCount: Object.values(shopFail).reduce((a, b) => a + b, 0),
    shopFail,
    serviceRecovered,
  };
  let reports = {};
  try { reports = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')); } catch (_) {}
  if (!reports || typeof reports !== 'object' || Array.isArray(reports)) reports = {};
  reports[dateLabel] = entry;
  const dates = Object.keys(reports).sort();
  while (dates.length > MAX_DAYS) { delete reports[dates.shift()]; }
  fs.writeFileSync(REPORT_PATH, JSON.stringify(reports, null, 2), 'utf8');
  console.log(`日报已写入信息看板：${REPORT_PATH}`);

  // 钉钉推送为可选开关：默认关闭（日报在信息看板查看）；config.json 设 "dailyReportDingTalk": true 或网页开启后，同时推送到钉钉。
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.dailyReportDingTalk === true && hasNotificationChannel(cfg)) {
      await sendNotification(cfg, markdown.split('\n').join('\n\n'), {
        markdown: true,
        title: `淘宝活动监控日报 ${dateLabel}`,
      });
      console.log('日报已同步推送钉钉（dailyReportDingTalk 开启）。');
    } else {
      console.log('日报未推送钉钉（dailyReportDingTalk 未开启，或未配置钉钉机器人）。');
    }
  } catch (error) {
    console.log('读取配置失败，日报未推送钉钉：' + (error.message || error));
  }
}

main().catch((error) => {
  console.error('日报生成失败：' + (error.stack || error.message || String(error)));
  process.exit(1);
});
