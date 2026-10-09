#!/usr/bin/env bash
set -euo pipefail
sudo systemctl stop tb-activity-monitor.service || true
sudo systemctl disable tb-activity-monitor.service || true
sudo rm -f /etc/systemd/system/tb-activity-monitor.service
sudo systemctl daemon-reload
echo "tb-activity-monitor 服务已卸载。"
