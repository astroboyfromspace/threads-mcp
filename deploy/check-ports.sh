#!/usr/bin/env bash
# Проверяет, свободны ли хостовые порты из .env, до того как docker compose
# упадёт с «address already in use» на половине поднятых контейнеров.
#
#   ./deploy/check-ports.sh
set -uo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Нет файла .env — скопируй .env.example и заполни." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

ADDR="${API_BIND_ADDR:-127.0.0.1}"
API_PORT="${API_BIND_PORT:-18080}"
NOVNC_PORT="${NOVNC_BIND_PORT:-16080}"

busy=0

# Кто слушает порт. ss есть почти везде, lsof — запасной вариант для macOS.
listener() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :${port}" 2>/dev/null | tail -n +2
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | tail -n +2
  fi
}

check() {
  local name="$1" port="$2"
  local who
  who="$(listener "${port}")"

  if [[ -n "${who}" ]]; then
    # Порт, занятый нашим же контейнером, — не проблема: это перезапуск.
    if grep -qi "threads-api" <<<"${who}"; then
      echo "✓ ${name}: ${ADDR}:${port} — занят нашим же контейнером (перезапуск это переживёт)"
      return 0
    fi
    echo "✗ ${name}: ${ADDR}:${port} УЖЕ ЗАНЯТ:"
    sed 's/^/    /' <<<"${who}"
    busy=1
    return 1
  fi

  echo "✓ ${name}: ${ADDR}:${port} свободен"
}

echo "Проверяю порты из .env…"
check "API"   "${API_PORT}"
check "noVNC" "${NOVNC_PORT}"

if [[ ${busy} -eq 1 ]]; then
  echo
  echo "Поменяй API_BIND_PORT / NOVNC_BIND_PORT в .env на свободные и перегенерируй"
  echo "конфиг nginx: ./deploy/render-nginx.sh"
  exit 1
fi

echo
echo "Порты свободны. Можно поднимать: docker compose up -d --build"
