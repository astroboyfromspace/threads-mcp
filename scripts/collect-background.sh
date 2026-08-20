#!/usr/bin/env bash
# Запускает сборщик датасета в фоне, отвязав его от терминала: прогон на тысячу
# постов идёт часами, а рвущаяся ssh-сессия убила бы его сигналом на середине.
#
#   ./scripts/collect-background.sh 1000
#   ./scripts/collect-background.sh 50 --limit 20
#   ./scripts/collect-background.sh stop
#   ./scripts/collect-background.sh status
#
# Всё, что после числа, уходит в сборщик как есть.
#
# Сам сборщик переживает временные ошибки внутри прогона (повторы и передышки),
# но от падения процесса — убитый браузер, кончившаяся память, севший сервис —
# он защититься не может. Поэтому здесь сидит присмотрщик: пока цель не набрана,
# он поднимает сборщик заново, вычитая уже собранное из остатка.
set -uo pipefail

cd "$(dirname "$0")/.."

LOCK="var/collect.lock"
PIDFILE="var/collect.pid"

# Сколько раз поднимать упавший сборщик и сколько ждать перед подъёмом. Пять
# заходов — это примерно полчаса ожидания вдобавок к самим прогонам: если и
# после этого не встаёт, дело не в невезении, и лучше разбудить человека.
# Переопределяются переменными окружения — этим же пользуется проверка скрипта,
# которой некогда ждать пять минут между заходами.
MAX_RESTARTS="${MAX_RESTARTS:-5}"
RESTART_PAUSE="${RESTART_PAUSE:-300}"

stamp() { date +%H:%M:%S; }
say() { echo "[$(stamp)] $*"; }

# Живой присмотрщик — это записанный pid, который ещё существует. Осиротевший
# pidfile (после kill -9 или перезагрузки) не должен выглядеть как работа.
running_pid() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

# Присмотрщик: крутит сборщик, пока цель не набрана или пока падения не станут
# безнадёжными. Запускается этим же файлом с флагом --supervise, уже отвязанным
# от терминала, — снаружи звать его руками незачем.
supervise() {
  local target="$1"; shift
  echo "$$" >"$PIDFILE"
  trap 'say "получен сигнал — останавливаюсь"; rm -f "$PIDFILE"; exit 143' TERM INT

  local remaining="$target" attempt=1 restarts=0
  local code offset chunk got stopped

  while :; do
    # Отметка длины лога: после захода читаем только его кусок, иначе итог
    # прошлого захода сойдёт за итог текущего.
    offset=$(stat -c %s "$COLLECT_LOG" 2>/dev/null || echo 0)
    say "присмотрщик: заход $attempt, осталось набрать $remaining"

    npm run collect -- --target "$remaining" "$@"
    code=$?

    chunk=$(tail -c "+$((offset + 1))" "$COLLECT_LOG" 2>/dev/null)
    got=$(grep -o 'Готово: +[0-9]\+' <<<"$chunk" | tail -1 | grep -o '[0-9]\+')
    stopped=$(grep -o 'остановка — [A-Za-z_]\+' <<<"$chunk" | tail -1 | sed 's/^остановка — //')
    # Молчащий лог — это падение до итоговой строки: считаем, что заход не
    # принёс ничего. Хуже, чем правда (что-то в базу лечь успело), но честнее,
    # чем поверить в несуществующий прогресс и недобрать цель.
    [[ "$got" =~ ^[0-9]+$ ]] || got=0

    remaining=$((remaining - got))
    if [[ "$stopped" == "target_reached" || "$remaining" -le 0 ]]; then
      say "итог: цель набрана за $attempt заход(а/ов)"
      break
    fi

    case "$stopped" in
      rate_limited|queries_exhausted|NEEDS_LOGIN|SELECTOR_MISS|UNAUTHORIZED)
        # Всё это ожиданием не лечится: квота кончилась до завтра, слова
        # кончились, сессия или вёрстка требуют рук. Перезапуск только сожжёт
        # время и добавит подозрительной активности.
        say "итог: остановка «$stopped» — перезапуск не поможет, недобрано $remaining"
        break
        ;;
    esac

    restarts=$((restarts + 1))
    if [[ "$restarts" -gt "$MAX_RESTARTS" ]]; then
      say "итог: $MAX_RESTARTS перезапусков не помогли (последний код $code), недобрано $remaining"
      break
    fi

    say "присмотрщик: заход кончился неудачей (код $code, остановка «${stopped:-нет итога}»), подъём $restarts/$MAX_RESTARTS через $((RESTART_PAUSE / 60)) мин"
    sleep "$RESTART_PAUSE"
    attempt=$((attempt + 1))
  done

  rm -f "$PIDFILE"
}

case "${1:-}" in
  --supervise)
    shift
    supervise "$@"
    exit 0
    ;;
  stop)
    pid="$(running_pid)" || { echo "Сборщик не запущен." >&2; exit 1; }
    # Сигнал всей группе: присмотрщик увёл её в свою сессию через setsid, и в
    # ней же сидят npm с node. Убить только присмотрщика значило бы оставить
    # сборщик сиротой — он бы доработал прогон, которого никто не ждёт.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Не отзывается на TERM, добиваю." >&2
      kill -KILL -- "-$pid" 2>/dev/null
    fi
    rm -f "$PIDFILE"
    echo "Остановлен. Собранное осталось в var/collect.sqlite."
    exit 0
    ;;
  status)
    if pid="$(running_pid)"; then
      log="$(ls -t var/collect-*.log 2>/dev/null | head -1)"
      echo "Сборщик работает, pid $pid."
      [[ -n "$log" ]] && { echo "Лог: $log"; tail -n 3 "$log"; }
      exit 0
    fi
    echo "Сборщик не запущен."
    exit 1
    ;;
esac

TARGET="${1:-}"
if [[ ! "$TARGET" =~ ^[0-9]+$ ]] || [[ "$TARGET" -eq 0 ]]; then
  cat >&2 <<USAGE
Сколько новых постов собрать? Например: ./scripts/collect-background.sh 1000
Ещё умеет: stop (остановить), status (что сейчас).
USAGE
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
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Сборщик уже работает (замок $LOCK). Посмотреть: ./scripts/collect-background.sh status" >&2
  exit 1
fi

LOG="var/collect-$(date +%Y%m%d-%H%M%S).log"
export COLLECT_LOG="$LOG"

# setsid уводит присмотрщика в свою сессию, поэтому SIGHUP при разрыве ssh до
# него не доходит, а stop может одним сигналом накрыть всю группу. Замок держим
# не мы, а он: своё описание 9 он наследует, наша копия закрывается вместе с
# этим скриптом.
setsid nohup "$0" --supervise "$TARGET" "$@" >"$LOG" 2>&1 &
PID=$!
exec 9>&-

sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  # Процесса нет — это либо падение на старте, либо честно доделанная работа:
  # маленькая цель набирается быстрее, чем мы успеваем моргнуть. Отличаем по
  # итоговой строке присмотрщика, иначе успех выглядел бы как отказ.
  if grep -q "] итог:" "$LOG"; then
    echo "Всё уже закончилось, так быстро:"
    grep "] итог:" "$LOG"
    echo "Лог: $LOG"
    exit 0
  fi
  echo "Присмотрщик умер сразу после старта, вот его вывод:" >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi

cat <<INFO
Сборщик работает в фоне, pid $PID, цель $TARGET постов.
Терминал можно закрывать.

  смотреть      tail -f $LOG
  что сейчас    ./scripts/collect-background.sh status
  остановить    ./scripts/collect-background.sh stop
  выгрузить     npm run collect -- --export dataset.csv

Собранное остаётся в var/collect.sqlite даже если прогон оборвать: каждое
слово пишется в базу сразу, а не в конце. Упавший сборщик присмотрщик поднимет
сам — до $MAX_RESTARTS раз, вычитая уже собранное из остатка.
INFO
