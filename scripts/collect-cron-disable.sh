#!/usr/bin/env bash
# Снимает регулярный сбор с крона: вырезает из crontab весь блок между метками
# collect-cron:begin и collect-cron:end — вместе со строкой, которая зовёт этот
# самый скрипт. Сбор ставился на срок, и молча работающий вечно робот — это
# лишний расход квоты и лишний риск для аккаунта.
#
# Метки, а не поиск по имени файла: так вырезается ровно то, что ставилось,
# и ничьи чужие задания не задеваются.
set -uo pipefail

MARK_BEGIN="# collect-cron:begin"
MARK_END="# collect-cron:end"

current="$(crontab -l 2>/dev/null)" || current=""

if ! grep -qF "$MARK_BEGIN" <<<"$current"; then
  echo "Блока $MARK_BEGIN в crontab нет — снимать нечего."
  exit 0
fi

# Пустой crontab -l у awk с BEGIN-блоком дал бы пустой вывод и снёс бы всё
# остальное, поэтому фильтруем строками, а не диапазоном awk.
filtered="$(awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
  index($0, b) == 1 { skip = 1 }
  skip != 1 { print }
  index($0, e) == 1 { skip = 0 }
' <<<"$current")"

printf '%s\n' "$filtered" | crontab -
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') — регулярный сбор снят с крона."
