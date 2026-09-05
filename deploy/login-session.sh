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
# Что открыть в окне. По умолчанию — форма входа, ради которой сеанс и заведён.
# Через noVNC адрес руками не вставишь (буфер обмена туда не проходит), поэтому
# для разовых проверок страницу задаём переменной, а не набираем в строке.
START_URL="${START_URL:-https://www.threads.net/login}"

export DISPLAY=":${DISPLAY_NUM}"

echo "Ставлю пакеты для графического сеанса…"
apt-get update -qq
apt-get install -y -qq xvfb x11vnc fluxbox novnc websockify >/dev/null

mkdir -p "${PROFILE_DIR}"

echo "Запускаю X-сервер на ${DISPLAY}…"
# -ac: X поднимает root, а Chromium ниже работает от pwuser — без этого флага
# X не пустит его на дисплей. Наружу дисплей не торчит, сеть только докерная.
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -ac &
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

# Chromium — от pwuser, того же пользователя, под которым профиль читает
# контейнер api: файлы, созданные root, сервис потом открыть не сможет.
# Заодно root-запуск Chromium вообще не стартует без песочницы.
# --no-sandbox: в контейнере нет прав на user namespaces, песочница не заводится;
# сеанс одноразовый и нужен только для страницы логина Threads.
chown -R pwuser:pwuser "${PROFILE_DIR}"
# Каталог сборки Chromium в образе Playwright сменил имя: до v1.5x это был
# chrome-linux, теперь chrome-linux64. Жёсткий путь молча превращался в
# «env: … No such file or directory», контейнер падал с кодом 127, а снаружи
# это выглядело как ошибка Cloudflare — искать причину приходилось в логах
# nginx. Поэтому ищем обе раскладки и падаем внятно, если не нашли.
CHROME=(/ms-playwright/chromium-*/chrome-linux64/chrome /ms-playwright/chromium-*/chrome-linux/chrome)
CHROME_BIN=""
for candidate in "${CHROME[@]}"; do
  if [ -x "${candidate}" ]; then CHROME_BIN="${candidate}"; break; fi
done
if [ -z "${CHROME_BIN}" ]; then
  echo "Не нашёл Chromium в /ms-playwright/chromium-*/ — образ Playwright сменил раскладку каталогов." >&2
  exit 1
fi

runuser -u pwuser -- env HOME=/home/pwuser DISPLAY="${DISPLAY}" \
  "${CHROME_BIN}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  --window-size=1440,900 \
  "${START_URL}"

wait
