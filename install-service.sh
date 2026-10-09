#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node)"
SERVICE_FILE="/etc/systemd/system/tb-activity-monitor.service"

sudo tee "$SERVICE_FILE" >/dev/null <<SERVICE
[Unit]
Description=Taobao/Tmall Activity Anomaly Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/monitor.js
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
Restart=always
RestartSec=15
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable tb-activity-monitor.service
sudo systemctl restart tb-activity-monitor.service
sudo systemctl --no-pager --full status tb-activity-monitor.service || true

echo
echo "服务已安装并启动。查看日志："
echo "  journalctl -u tb-activity-monitor -f"
echo "  tail -f $DIR/logs/monitor.log"
