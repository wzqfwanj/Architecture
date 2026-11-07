#!/bin/bash
# 在 dev 主机上执行：解包到 /opt/architecture、重启服务、冒烟自检
# 由 tools/deploy.py 通过 ssh 调用，参数：无（tar 包已在 /tmp/arch-deploy.tar.gz）
set -euo pipefail

APP=/opt/architecture
TAR=/tmp/arch-deploy.tar.gz
PORT=8060

[ -f "$TAR" ] || { echo '找不到部署包'; exit 1; }

echo '--- 解包 ---'
mkdir -p "$APP"
find "$APP" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$TAR" -C "$APP"
rm -f "$TAR"
chown -R root:root "$APP"
find "$APP" -type d -exec chmod 755 {} +
find "$APP" -type f -exec chmod 644 {} +

echo '--- 重启 ---'
systemctl restart architecture.service
sleep 2
systemctl is-active architecture.service

echo '--- 冒烟自检 ---'
PWD_=$(grep '^ARCH_PASSWORD=' /etc/architecture.env | cut -d= -f2-)
fail=0
for u in / /app.js /style.css /api/diagrams; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "admin:$PWD_" "http://127.0.0.1:$PORT$u")
  printf '  %-16s 带凭据 -> %s\n' "$u" "$code"
  [ "$code" = 200 ] || fail=1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
printf '  %-16s 无凭据 -> %s\n' '/' "$code"
[ "$code" = 401 ] || fail=1

# 源码不应可下载
code=$(curl -s -o /dev/null -w '%{http_code}' -u "admin:$PWD_" "http://127.0.0.1:$PORT/server.py")
printf '  %-16s -> %s（应为 404）\n' '/server.py' "$code"
[ "$code" = 404 ] || fail=1

if [ "$fail" != 0 ]; then
  echo 'SMOKE_FAILED'
  journalctl -u architecture.service -n 20 --no-pager
  exit 1
fi
echo 'REMOTE_OK'
