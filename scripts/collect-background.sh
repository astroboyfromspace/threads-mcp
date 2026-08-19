#!/usr/bin/env bash
# Запускает сборщик датасета в фоне, отвязав его от терминала: прогон на тысячу
# постов идёт часами, а рвущаяся ssh-сессия убила бы его сигналом на середине.
#
#   ./scripts/collect-background.sh 1000
#   ./scripts/collect-background.sh 50 --limit 20
#
# Всё, что после числа, уходит в сборщик как есть.
set -uo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [[ ! "$TARGET" =~ ^[0-9]+$ ]] || [[ "$TARGET" -eq 0 ]]; then
  echo "Сколько новых постов собрать? Например: ./scripts/collect-background.sh 1000" >&2
  exit 1
fi
shift

if [[ ! -f .env ]]; then
  echo "Нет файла .env — без него неизвестен токен сервиса." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

if [[ -z "${API_TOKEN:-}" ]]; then
  echo "В .env не задан API_TOKEN — сервис не пустит." >&2
  exit 1
fi

# Контейнер отдаёт наружу порт из .env, а сборщик по умолчанию идёт на 8080 —
# это адрес сервиса изнутри контейнера, снаружи там ничего нет.
: "${THREADS_API_URL:=http://127.0.0.1:${API_BIND_PORT:-18080}}"
export THREADS_API_URL API_TOKEN

if ! curl -sf -m 5 "${THREADS_API_URL}/health" >/dev/null; then
  echo "Сервис не отвечает на ${THREADS_API_URL} — подними его: docker compose up -d" >&2
  exit 1
fi

mkdir -p var

# Два сборщика разом — это двойной расход суточной квоты ради одних и тех же
# постов: оба возьмут из базы один и тот же список слов. Замок дешевле, чем
# потом гадать, почему квота кончилась вдвое быстрее.
LOCK="var/collect.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Сборщик уже работает (замок $LOCK). Посмотреть: tail -f var/collect-*.log" >&2
  exit 1
fi

LOG="var/collect-$(date +%Y%m%d-%H%M%S).log"

# setsid уводит процесс в свою сессию, поэтому SIGHUP при разрыве ssh до него
# не доходит. Замок держим не мы, а сам фоновый процесс: своё описание 9 он
# наследует, наша копия закрывается вместе с этим скриптом.
setsid nohup npm run collect -- --target "$TARGET" "$@" >"$LOG" 2>&1 &
PID=$!
exec 9>&-

sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  # Процесса нет — это либо падение на старте, либо честно доделанная работа:
  # маленькая цель набирается из одной ленты быстрее, чем мы успеваем моргнуть.
  # Отличаем по итоговой строке сборщика, иначе успех выглядел бы как отказ.
  if grep -q "^Готово:" "$LOG"; then
    echo "Прогон уже закончился, так быстро:"
    grep "^Готово:" "$LOG"
    echo "Лог: $LOG"
    exit 0
  fi
  echo "Сборщик умер сразу после старта, вот его вывод:" >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi

cat <<INFO
Сборщик работает в фоне, pid $PID, цель $TARGET постов.
Терминал можно закрывать.

  смотреть      tail -f $LOG
  остановить    kill $PID
  выгрузить     npm run collect -- --export dataset.csv

Собранное остаётся в var/collect.sqlite даже если прогон оборвать: каждое
слово пишется в базу сразу, а не в конце.
INFO
