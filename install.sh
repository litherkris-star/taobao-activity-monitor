#!/usr/bin/env bash
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${1:-$HOME/tb-monitor}"
mkdir -p "$TARGET_DIR" "$TARGET_DIR/logs" "$TARGET_DIR/data" "$TARGET_DIR/profiles"

FILES=(
  monitor.js page-logic.js notifier.js notification-test.js
  configure.js whitelist-manager.js shop-login.js package.json config.example.json
  admin-server.js admin.html 商品导入模板.xlsx
  install-service.sh uninstall-service.sh manage.sh README.md
)
for file in "${FILES[@]}"; do cp "$SOURCE_DIR/$file" "$TARGET_DIR/$file"; done

if [ ! -f "$TARGET_DIR/config.json" ]; then cp "$SOURCE_DIR/config.example.json" "$TARGET_DIR/config.json"; fi
cd "$TARGET_DIR"
npm install
npx playwright install chromium || true
chmod +x install-service.sh uninstall-service.sh manage.sh

echo
echo "淘宝/天猫活动异常监控安装完成：$TARGET_DIR"
echo
echo "接下来的步骤："
echo "1. 编辑 $TARGET_DIR/config.json，填入钉钉机器人 webhook/secret（或运行 node configure.js 交互配置店铺与商品）。"
echo "2. 测试钉钉机器人：node notification-test.js"
echo "3. 每个店铺登录一次（需要图形界面）：node shop-login.js shop01"
echo "4. 手动跑一轮验证：node monitor.js --once"
echo "5. 安装为系统服务并开机自启：./install-service.sh"
echo "6. 日常管理：./manage.sh {once|start|stop|restart|status|logs|file-logs}"
