'use strict';

const crypto = require('crypto');

function clean(value) {
  return String(value || '').trim();
}

function normalizeNotificationConfig(config = {}) {
  const dingtalkRaw = config.dingtalk && typeof config.dingtalk === 'object' ? config.dingtalk : {};
  const dingtalk = {
    webhook: clean(dingtalkRaw.webhook || config.dingtalkWebhook),
    secret: clean(dingtalkRaw.secret || config.dingtalkSecret),
    atAll: dingtalkRaw.atAll === true || config.dingtalkAtAll === true,
    atMobiles: Array.isArray(dingtalkRaw.atMobiles) ? dingtalkRaw.atMobiles.map((item) => clean(item)).filter(Boolean) : [],
  };
  return { provider: 'dingtalk', dingtalk };
}

function hasNotificationChannel(config = {}) {
  return Boolean(normalizeNotificationConfig(config).dingtalk.webhook);
}

function notificationChannelLabel() {
  return '钉钉';
}

function buildSignedDingTalkUrl(webhook, secret) {
  const url = new URL(webhook);
  if (!secret) return url.toString();
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

async function postDingTalk(dingtalk, content, options = {}) {
  if (!dingtalk || !clean(dingtalk.webhook)) throw new Error('未配置钉钉机器人 Webhook');
  const requestUrl = buildSignedDingTalkUrl(clean(dingtalk.webhook), clean(dingtalk.secret));
  // 支持调用方追加本次消息要 @ 的手机号（如异常商品的负责人），与全局 atMobiles 合并去重。
  const extraAt = Array.isArray(options.atMobiles) ? options.atMobiles.map((item) => clean(item)).filter(Boolean) : [];
  const at = {
    atMobiles: [...new Set([...(dingtalk.atMobiles || []), ...extraAt])],
    atUserIds: [],
    isAtAll: dingtalk.atAll === true,
  };
  // markdown 类型支持 <font color> 标红等富文本；text 类型保持原样。
  const body = options.markdown
    ? {
      msgtype: 'markdown',
      markdown: { title: clean(options.title) || '淘宝/天猫活动监控提醒', text: String(content || '') },
      at,
    }
    : {
      msgtype: 'text',
      text: { content: String(content || '') },
      at,
    };
  // 15 秒超时：钉钉接口卡住时快速失败，绝不能拖死整个检测轮（曾导致检测时间戳冻结）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('钉钉接口 15 秒无响应（网络异常），本次通知发送失败');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`钉钉 HTTP ${response.status}: ${text}`);
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = null; }
  if (payload && Number(payload.errcode) !== 0) throw new Error(`钉钉返回错误：${text}`);
  return payload || text;
}

async function sendNotification(config, content, options = {}) {
  const notification = normalizeNotificationConfig(config);
  if (!notification.dingtalk.webhook) throw new Error('没有配置钉钉机器人 Webhook');
  await postDingTalk(notification.dingtalk, content, options);
  return ['钉钉'];
}

module.exports = {
  normalizeNotificationConfig,
  hasNotificationChannel,
  notificationChannelLabel,
  buildSignedDingTalkUrl,
  postDingTalk,
  sendNotification,
};
