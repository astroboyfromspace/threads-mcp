# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

`threads-api` — личный сервис на VPS, дающий агенту программный доступ к одному
аккаунту Threads. Подробности пользовательского сценария — в `README.md`,
обоснование архитектурных решений — в `docs/plans/2026-08-17-threads-api-design.md`,
пошаговый деплой — в `docs/DEPLOY-RUNBOOK.md`.

**Язык проекта — русский**: комментарии в коде, сообщения об ошибках, описания
действий, документация и коммиты пишутся по-русски. Придерживайся этого.

## Команды

```bash
npm test                          # vitest run — все тесты, живой аккаунт не нужен
npx vitest run test/oauth.test.ts  # один файл
npx vitest run -t "имя теста"      # один тест по названию
npm run typecheck                 # tsc --noEmit
npm run build                     # tsc -> dist/
npm run dev                       # tsx watch src/main.ts (нужен заполненный .env)
npm run mcp                       # MCP-сервер по stdio (после build)
npm run auth                      # разовый OAuth-обмен из терминала
```

Линтера в проекте нет — проверка это `npm run typecheck` + `npm test`.
Тесты подставляют обязательные переменные окружения через `test/setup-env.ts`
(конфиг валидируется на импорте модуля, поэтому переменные должны существовать
раньше, чем тест дотянется до `src/config.ts`).

## Архитектура

Ключевая идея: **два драйвера, один реестр действий**.

- `src/actions/registry.ts` — единственная точка выполнения. Каждое действие
  описано как `{name, description, driver: "graph" | "browser", input: zod-схема,
  dailyLimit?, run}`. `execute()` валидирует вход, проверяет логин и суточные
  лимиты, пишет журнал в SQLite. **И HTTP, и MCP ходят только сюда** — расхождений
  между двумя интерфейсами быть не может по построению. Новое действие добавляется
  правкой одного этого файла; оно автоматически появляется и в `GET /actions`,
  и в списке инструментов MCP.
- `driver: "graph"` — публикация, ответы, чтение своих постов, квоты. Идёт через
  официальный Threads Graph API (`src/graph/`).
- `driver: "browser"` — лайки, подписки, репосты, чтение ленты и чужих профилей.
  Официальным API не покрыто, выполняется Playwright'ом с сохранённой сессией
  (`src/browser/`).

Транспорты:
- `src/http/server.ts` — Fastify. Одна ручка `POST /actions/:action` на всё,
  плюс синоним `POST /post`, `GET /health` (открыт), OAuth-маршруты и
  `/browser/suspend|resume|login-check`. Авторизация — `Bearer` из `API_TOKEN`,
  сравнение через `timingSafeEqual`.
- `src/mcp/main.ts` — MCP по stdio, тонкая обёртка над тем же `execute()`.
  Ошибки отдаются как результат с `isError`, а не как исключение протокола:
  агенту нужен разбираемый код.

### Ответы и ошибки

Единый конверт: `{"ok": true, "data": …}` либо
`{"ok": false, "error": {code, message, retryable, retry_after?, details?}}`.
Коды и их HTTP-статусы заданы в `src/errors.ts` (`ActionError`, `httpStatusFor`):
`NEEDS_LOGIN` 503, `RATE_LIMITED` 429, `UPSTREAM` 502, `SELECTOR_MISS` 500,
`INVALID_INPUT` 400, `INTERNAL` 500. Любую ожидаемую ошибку бросай как
`ActionError` — конверт соберётся сам.

### Состояние

`src/db.ts` — SQLite (better-sqlite3, WAL) в `DATA_DIR`. Три таблицы: `token`
(ровно одна строка), `action_log` (журнал всех вызовов, включая отвергнутые —
иначе по логам не отличить «не звали» от «позвали с мусором»; из него же
считаются суточные лимиты) и `oauth_state` (одноразовые state, TTL 15 минут).

### Токен Threads

`src/graph/token.ts` — единственная точка получения токена. `getValidToken()`
сам продлевает долгоживущий токен, когда до истечения меньше 10 дней. OAuth:
`/oauth/start` требует bearer и выдаёт одноразовый state, `/oauth/callback`
открыт (Threads редиректит браузер без заголовков) и обязан проверять state —
без этого посторонний мог бы подменить аккаунт сервиса.

### Браузерный слой

- `src/browser/session.ts` — один персистентный контекст Chromium на весь сервис
  (`launchPersistentContext` по `DATA_DIR/profile`). Пароль нигде не хранится:
  человек логинится один раз руками через noVNC.
- `src/browser/queue.ts` — `SerialQueue`: профиль один, параллельные обращения к
  нему — гонка, поэтому все браузерные задачи идут строго по одной, а при
  переполнении очереди отдаётся `RATE_LIMITED`.
- **suspend/resume**: Chromium не открывает один user-data-dir дважды. Чтобы
  человек мог войти через noVNC, сервис обязан временно закрыть свой контекст —
  это и делают `POST /browser/suspend` → `docker compose --profile login up -d novnc`
  → `POST /browser/resume`.
- `src/browser/selectors.ts` — **все** зацепки за вёрстку Threads. Опора на роли
  и подписи доступности, подписи дублируются на русском и английском (язык UI
  зависит от аккаунта). При редизайне Threads правится только этот файл.
- Когда элемент не найден — `SELECTOR_MISS` со скриншотом в `DATA_DIR/failures/`
  (`captureFailure`). Паузы между действиями случайные (`humanDelay`).
- Браузерные действия тестами не покрыты: они зависят от живой вёрстки.
  Покрыты очередь, реестр, OAuth, HTTP и Graph-слой.

### Лимиты

Graph-квоты считает сам Threads (`get_quota`). Браузерные действия ограничены
собственными счётчиками из `action_log` (`LIMIT_*_PER_DAY`) — лимиты намеренно
консервативные, это защита аккаунта от блокировки.

## Деплой

Docker Compose + хостовый nginx с TLS. Все хостовые порты задаются **только в
`.env`**: оттуда их берёт и `docker-compose.yml`, и `deploy/render-nginx.sh`,
поэтому разъехаться они не могут. Контейнеры слушают исключительно `127.0.0.1`.
Версия базового образа Playwright в `Dockerfile` обязана совпадать с версией
`playwright` в `package.json`.
