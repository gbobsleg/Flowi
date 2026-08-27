#!/usr/bin/env bash
# À exécuter sur le VPS : sudo bash /home/shifti_admin/flowi/deploy/apply-nginx.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/deploy/nginx-websocket-map.conf" /etc/nginx/conf.d/websocket_map.conf
cp "$ROOT/deploy/nginx-flowi.conf" /etc/nginx/sites-available/flowi
nginx -t
systemctl reload nginx
echo "nginx rechargé (auth_basic désactivé sur /socket.io/)"
