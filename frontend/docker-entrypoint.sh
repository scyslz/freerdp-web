#!/bin/sh
set -eu
cat > /usr/share/nginx/html/config.js <<EOF
window.__RDP_WS_PATH__ = "${RDP_WS_PATH:-/ws/}";
EOF
exec nginx -g 'daemon off;'
