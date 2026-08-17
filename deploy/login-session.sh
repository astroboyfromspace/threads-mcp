#!/usr/bin/env bash
# Графический сеанс для ручного входа в Threads.
#
# Поднимает X-сервер, оконный менеджер, VNC и веб-мост noVNC, после чего
# запускает Chromium с тем же профилем, которым пользуется сервис. Ты заходишь
# по https://<домен>/vnc/, логинишься как обычный человек — вместе с 2FA, — и
# закрываешь вкладку. Cookies остаются в общем томе.
set -euo pipefail

PROFILE_DIR="${PROFILE_DIR:-/var/lib/threads-api/profile}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN="${SCREEN:-1440x900x24}"

export DISPLAY=":${DISPLAY_NUM}"

echo "Ставлю пакеты для графического сеанса…"
apt-get update -qq
apt-get install -y -qq xvfb x11vnc fluxbox novnc websockify >/dev/null

mkdir -p "${PROFILE_DIR}"

echo "Запускаю X-сервер на ${DISPLAY}…"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" &
sleep 2

fluxbox >/dev/null 2>&1 &
sleep 1

# VNC без пароля, но слушает только внутреннюю сеть Docker: снаружи доступ
# идёт через Caddy, который требует basic-auth и TLS.
x11vnc -display "${DISPLAY}" -forever -shared -nopw -quiet -rfbport 5900 &
sleep 1

echo "Поднимаю noVNC на 6080…"
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 &
sleep 1

echo
echo "Открой https://<твой-домен>/vnc/vnc.html и залогинься в Threads."
echo "Профиль: ${PROFILE_DIR}"
echo "Закончишь — Ctrl+C здесь, затем POST /browser/resume."
echo

/ms-playwright/chromium-*/chrome-linux/chrome \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  --window-size=1440,900 \
  "https://www.threads.net/login"

wait
