#!/usr/bin/env bash
# Генерирует конфиг nginx из шаблона, подставляя домен и порты из .env.
# Порт задан ровно в одном месте (.env) и потому не может разъехаться с
# docker-compose.
#
#   ./deploy/render-nginx.sh              # печатает конфиг в stdout
#   ./deploy/render-nginx.sh --install    # ставит в sites-available и включает
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Нет файла .env — скопируй .env.example и заполни." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

DOMAIN="${DOMAIN:-}"
API_PORT="${API_BIND_PORT:-18080}"
NOVNC_PORT="${NOVNC_BIND_PORT:-16080}"

if [[ -z "${DOMAIN}" || "${DOMAIN}" == "example.com" ]]; then
  echo "Задай настоящий DOMAIN в .env" >&2
  exit 1
fi

TEMPLATE="deploy/nginx/threads-api.conf.template"
rendered="$(sed \
  -e "s#__DOMAIN__#${DOMAIN}#g" \
  -e "s#__API_PORT__#${API_PORT}#g" \
  -e "s#__NOVNC_PORT__#${NOVNC_PORT}#g" \
  "${TEMPLATE}")"

if [[ "${1:-}" != "--install" ]]; then
  printf '%s\n' "${rendered}"
  echo >&2
  echo "Это предпросмотр. Установить: sudo ./deploy/render-nginx.sh --install" >&2
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Установка требует root: sudo ./deploy/render-nginx.sh --install" >&2
  exit 1
fi

AVAILABLE="/etc/nginx/sites-available/threads-api.conf"
ENABLED="/etc/nginx/sites-enabled/threads-api.conf"
HTPASSWD="/etc/nginx/threads-novnc.htpasswd"

if [[ ! -f "${HTPASSWD}" ]]; then
  echo "Нет ${HTPASSWD} — без него nginx не стартует." >&2
  echo "Создай пароль для доступа к noVNC:" >&2
  echo "  sudo htpasswd -cB ${HTPASSWD} admin" >&2
  exit 1
fi

printf '%s\n' "${rendered}" > "${AVAILABLE}"
ln -sf "${AVAILABLE}" "${ENABLED}"

echo "Записан ${AVAILABLE} (API -> 127.0.0.1:${API_PORT}, noVNC -> 127.0.0.1:${NOVNC_PORT})"

# Проверяем конфиг до перезагрузки: битый конфиг уронил бы и соседние сайты.
if ! nginx -t; then
  echo "nginx -t не прошёл, ничего не перезагружаю." >&2
  echo "Если сертификата ещё нет, сначала выпусти его:" >&2
  echo "  certbot --nginx -d ${DOMAIN}" >&2
  exit 1
fi

systemctl reload nginx
echo "nginx перезагружен. Проверка: curl -s https://${DOMAIN}/health"
