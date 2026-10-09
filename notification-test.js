'use strict';

const { sendNotification } = require('./notifier');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.TB_CONFIG || path.join(__dirname, 'config.json');

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在：${CONFIG_PATH}，请先复制 config.example.json 为 config.json 并填写钉钉 Webhook。`);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const channels = await sendNotification(config, [
    '【淘宝/天猫活动监控测试】',
    '',
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '如果你看到这条消息，说明钉钉机器人配置正确。',
  ].join('\n'));
  console.log(`测试消息发送成功（${channels.join('、')}）。`);
}

main().catch((error) => {
  console.error(`发送失败：${error.message || error}`);
  process.exit(1);
});
