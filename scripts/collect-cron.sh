#!/usr/bin/env bash
# Обёртка для крона: у cron нет ни нашего PATH, ни рабочей папки, ни терминала,
# куда писать. Здесь всё это восстанавливается, а дальше работает обычный
# collect-background.sh — тот же, что запускают руками.
#
#   ./scripts/collect-cron.sh 500
#
# Вывод копится в var/cron.log: если утренний прогон не стартовал, узнать об
# этом можно только оттуда — письма от крона на этой машине никто не читает.
set -uo pipefail

cd "$(dirname "$0")/.."

# node стоит через nvm, и его папки нет в кроновском PATH. Берём самую свежую
# установку, а не прибитую версию: после обновления node прибитый путь молча
# перестал бы существовать, и прогон падал бы каждое утро.
if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
fi
[[ -n "$NODE_BIN" ]] && PATH="$NODE_BIN:$PATH"
export PATH

mkdir -p var
LOG="var/cron.log"

TARGET="${1:-500}"
shift 2>/dev/null || true

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') — запуск на $TARGET постов ==="
  if ! command -v npm >/dev/null; then
    echo "npm не найден (PATH=$PATH) — прогон не начат."
    exit 1
  fi
  ./scripts/collect-background.sh "$TARGET" "$@"
  code=$?
  echo "--- код выхода $code ---"
  exit "$code"
} >>"$LOG" 2>&1
