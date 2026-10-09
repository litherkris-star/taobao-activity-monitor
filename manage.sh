#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  once) node "$(dirname "$0")/monitor.js" --once ;;
  start) sudo systemctl start tb-activity-monitor ;;
  stop) sudo systemctl stop tb-activity-monitor ;;
  restart) sudo systemctl restart tb-activity-monitor ;;
  status) sudo systemctl --no-pager --full status tb-activity-monitor ;;
  logs) sudo journalctl -u tb-activity-monitor -f ;;
  file-logs) tail -f "$(dirname "$0")/logs/monitor.log" ;;
  *) echo "用法：./manage.sh {once|start|stop|restart|status|logs|file-logs}"; exit 1 ;;
esac
