#!/usr/bin/env bash
# Запуск сервиса вместе с виртуальным экраном.
#
# Браузер работает не в headless-режиме, а в настоящем окне: при headless: true
# Playwright поднимает урезанный chromium_headless_shell, который сам пишет о
# себе «HeadlessChrome» в User-Agent и в Client Hints. Окно рисуется на Xvfb и
# никому не показывается.
#
# Xvfb поднимается здесь руками, а не через xvfb-run, хотя тот и стоит в
# образе: xvfb-run ждёт готовности X-сервера через сигнал USR1, и в роли
# процесса номер один в контейнере это ожидание не заканчивается никогда —
# сервис так и не стартует. Проверено: Xvfb жив, node не запущен.
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
# Экран размером с viewport из session.ts: окно, не помещающееся в экран,
# Chromium ужимает, и вёрстка поедет не так, как её видит человек.
SCREEN="${SCREEN:-1280x900x24}"
SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp &

# Ждём сокет: Chromium, запущенный раньше готовности X, падает с «Missing X
# server». Секунды хватает с запасом, но лучше проверить, чем спать вслепую.
for _ in $(seq 1 50); do
  [[ -e "$SOCKET" ]] && break
  sleep 0.1
done
if [[ ! -e "$SOCKET" ]]; then
  echo "X-сервер не поднялся за 5 секунд — браузеру негде рисовать." >&2
  exit 1
fi

export DISPLAY=":${DISPLAY_NUM}"

# Снимаем замок профиля от прошлого запуска. Chromium помечает профиль файлом
# SingletonLock со ссылкой вида «хост-pid» и отказывается открывать чужой:
# «profile appears to be in use by another Chromium process on another
# computer». При пересборке контейнера хост меняется, а замок остаётся в томе —
# и сервис после каждого docker compose up отказывался поднимать браузер.
#
# Здесь мы точно первые: контейнер только что стартовал, своего Chromium в нём
# ещё нет. Единственный, кто может держать профиль по-настоящему, — сеанс
# ручного входа noVNC, но его и так положено запускать только после
# POST /browser/suspend, когда сервис профиль отпустил.
PROFILE_DIR="${PROFILE_DIR:-/var/lib/threads-api/profile}"
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie"

# exec: node занимает место этого скрипта и становится процессом номер один,
# поэтому docker stop приходит именно ему, а не оболочке. Xvfb остаётся его
# потомком и уходит вместе с контейнером.
exec node dist/src/main.js
