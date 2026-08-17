# Threads как API

Личный сервис на VPS, дающий агенту программный доступ к одному аккаунту Threads:
публикация, ответы, лайки, подписки, репосты, чтение ленты и профилей.

Публикация и ответы идут через официальный Threads API — стабильно и в рамках правил.
Лайки, подписки и лента официальным API не покрыты, поэтому выполняются браузером
с сохранённой сессией. Какой путь выбрать, решает сервис; агент просто зовёт действие.

## Что нужно до начала

1. **VPS** с Docker и доменом, направленным на его IP (для TLS).
2. **Приложение Threads**: developers.facebook.com → создать приложение → сценарий
   использования «Threads API». Понадобятся App ID, App Secret и Redirect Callback URL
   вида `https://<домен>/oauth/callback`.
3. Аккаунт Threads, под которым всё будет работать.

## Настройка

```bash
cp .env.example .env
openssl rand -hex 32          # положи в API_TOKEN
htpasswd -nbB admin 'пароль'  # хеш после «admin:» положи в NOVNC_USER_HASH
```

В `.env` заполни `API_TOKEN`, `THREADS_APP_ID`, `THREADS_APP_SECRET`,
`THREADS_REDIRECT_URI`, а также `DOMAIN` и `NOVNC_USER_HASH` — их читает Caddy.

```bash
docker compose up -d --build
curl https://<домен>/health
```

## Первый запуск: две авторизации

Их именно две, и они независимы.

### 1. Threads API (для публикации)

Открой в браузере, подставив свой токен:

```
https://<домен>/oauth/start
```

Разреши доступ. Тебя вернёт на `/oauth/callback`, токен сохранится и дальше будет
продлеваться сам. Проверка:

```bash
curl -H "Authorization: Bearer $API_TOKEN" https://<домен>/actions/get_my_profile -X POST -d '{}'
```

### 2. Браузерная сессия (для лайков и ленты)

Chromium не открывает один профиль дважды, поэтому сначала отбираем профиль у сервиса:

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" https://<домен>/browser/suspend -d '{"minutes": 20}'
docker compose --profile login up -d novnc
```

Открой `https://<домен>/vnc/vnc.html`, войди под своим паролем от noVNC, залогинься
в Threads в открывшемся окне Chromium — с 2FA, как обычный человек. Затем:

```bash
docker compose --profile login down
curl -X POST -H "Authorization: Bearer $API_TOKEN" https://<домен>/browser/resume
```

Ответ `{"loggedIn": true}` означает, что браузерные действия готовы.

Логин делается на самом VPS намеренно: IP при входе и при работе совпадает, и сессия
живёт заметно дольше, чем перенесённые с ноутбука cookies. Повторять придётся раз в
несколько недель, когда Threads разлогинит сессию.

## Использование

```bash
# Что вообще умеет
curl -H "Authorization: Bearer $API_TOKEN" https://<домен>/actions

# Пост
curl -X POST https://<домен>/post \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"text": "привет из агента"}'

# Ответ на комментарий
curl -X POST https://<домен>/actions/reply_to_post \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"reply_to_id": "<media-id>", "text": "спасибо!"}'

# Лайк
curl -X POST https://<домен>/actions/like_post \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"url": "https://www.threads.net/@someone/post/abc"}'
```

Ответ всегда одной формы: `{"ok": true, "data": …}` либо
`{"ok": false, "error": {"code", "message", "retryable", "retry_after"}}`.

Коды ошибок: `NEEDS_LOGIN` (нужен ручной вход), `RATE_LIMITED`, `UPSTREAM`,
`SELECTOR_MISS` (Threads изменил вёрстку — в `var/failures/` лежит скриншот),
`INVALID_INPUT`.

## Подключение к агенту

Через MCP — Claude Code увидит все действия как инструменты:

```json
{
  "mcpServers": {
    "threads": {
      "command": "node",
      "args": ["/путь/к/проекту/dist/src/mcp/main.js"],
      "env": { "API_TOKEN": "…", "THREADS_APP_ID": "…", "THREADS_APP_SECRET": "…", "THREADS_REDIRECT_URI": "…" }
    }
  }
}
```

MCP-сервер работает с тем же реестром действий, что и HTTP, — расхождений между
двумя интерфейсами быть не может.

## Лимиты

Официальный API: 250 постов, 1000 ответов, 100 удалений в сутки — их считает Threads,
текущее потребление показывает действие `get_quota`.

Браузерные действия ограничены нашими собственными счётчиками (по умолчанию 150 лайков,
50 подписок, 30 репостов в сутки) и разделены случайными паузами. Лимиты намеренно
консервативные.

**Риск.** Автоматизация лайков, подписок и чтения ленты через браузер нарушает условия
Meta и может привести к блокировке аккаунта. Постинг и ответы через официальный API
этой проблемы не имеют.

## Разработка

```bash
npm install
npm test          # 45 тестов, живой аккаунт не нужен
npm run typecheck
npm run dev
```

Браузерные действия тестами не покрываются: они зависят от живой вёрстки Threads.
Все зацепки за DOM собраны в `src/browser/selectors.ts` — при редизайне правится
один файл.

Дизайн и обоснование решений: `docs/plans/2026-08-17-threads-api-design.md`.
