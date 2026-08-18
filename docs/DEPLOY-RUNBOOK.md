# Ранбук развёртывания: Threads как API

Инструкция для агента, разворачивающего сервис на боевом VPS.

**Контекст.** На хосте уже работают другие сервисы. nginx и certbot стоят на самом
хосте, не в контейнере. Занимать порты вслепую и трогать чужие конфиги нельзя.

**Правила работы по этому документу:**

- Шаги выполняются по порядку. У каждого есть проверка — не переходи дальше, пока
  она не прошла.
- Ничего не удаляй и не перезаписывай в `/etc/nginx/`, кроме файлов с именем
  `threads-api.conf` и `threads-novnc.htpasswd`.
- Два шага (8 и 9) требуют действий живого человека в браузере. Их выполнить за
  него нельзя — останови работу и попроси.
- Если проверка не прошла — не переходи к следующему шагу и не «чини» обходным
  путём. Сообщи, что именно не сошлось, и покажи вывод.

---

## Шаг 0. Что должно быть готово заранее

Проверь и доложи, если чего-то нет:

```bash
docker --version && docker compose version
nginx -v
certbot --version
```

Ещё нужны, но проверяются позже:

- Домен, A-записью указывающий на IP этого сервера.
- App ID и App Secret приложения Threads (developers.facebook.com, сценарий
  использования «Threads API»).

---

## Шаг 1. Код на сервере

```bash
git clone <репозиторий> /opt/threads-api
cd /opt/threads-api
```

Если каталог занят — остановись и спроси, куда ставить. Не перезаписывай.

**Проверка:** `ls /opt/threads-api/docker-compose.yml` находит файл.

---

## Шаг 2. Конфигурация

```bash
cd /opt/threads-api
cp .env.example .env
```

Заполни в `.env`:

| Переменная | Чем заполнить |
|---|---|
| `API_TOKEN` | `openssl rand -hex 32` |
| `THREADS_APP_ID` | из приложения Threads |
| `THREADS_APP_SECRET` | из приложения Threads |
| `THREADS_REDIRECT_URI` | `https://<домен>/oauth/callback` |
| `DOMAIN` | боевой домен |
| `API_BIND_PORT` | свободный порт, по умолчанию `18080` |
| `NOVNC_BIND_PORT` | свободный порт, по умолчанию `16080` |
| `PUBLIC_MEDIA_BASE_URL` | `https://<домен>` — нужен только для постов с медиа с локального диска, иначе оставь пустым |

`API_BIND_ADDR` оставь `127.0.0.1`. Наружу сервис отдаёт nginx; прямой доступ в
обход него означал бы API без TLS.

**Redirect URI обязан совпадать символ в символ** со значением в настройках
приложения Threads. Расхождение проявится только на шаге 8 — ошибкой, которая не
объясняет причину.

Дальше по документу идут `curl` с `Bearer $API_TOKEN`. Переменная не появится в
оболочке сама — подгрузи `.env` в текущую сессию и повторяй это после каждого
нового входа на сервер:

```bash
set -a; source .env; set +a
```

**Проверка:** все обязательные переменные заполнены —

```bash
for v in API_TOKEN THREADS_APP_ID THREADS_APP_SECRET THREADS_REDIRECT_URI DOMAIN; do
  grep -q "^$v=.\+" .env || echo "не заполнено: $v"
done
```

Команда не должна напечатать ничего. Считать непустые строки целиком нельзя:
`.env.example` уже содержит около десятка заполненных (порты, лимиты, `HOST`),
и такая проверка пройдёт при пустых токенах.

---

## Шаг 3. Порты

На хосте есть соседние сервисы, поэтому порты проверяются до запуска:

```bash
./deploy/check-ports.sh
```

Если порт занят — подставь в `.env` свободный (например, `18081` / `16081`) и
запусти проверку снова. Скрипт различает чужой процесс и наш собственный
контейнер: занятость нашим же контейнером при перезапуске это норма.

**Проверка:** скрипт завершается с кодом 0 и сообщает, что порты свободны.

---

## Шаг 4. Сборка и запуск контейнера

```bash
docker compose up -d --build
```

Первая сборка тянет образ Playwright — это несколько минут и около 2 ГБ.

```bash
docker compose ps
curl -s http://127.0.0.1:${API_BIND_PORT:-18080}/health
```

**Проверка:** `/health` отвечает JSON с `"ok":true`. Поле `graph_token` пока
`null` — так и должно быть, токен появится на шаге 8.

Если контейнер не поднялся: `docker compose logs --tail=50 api`.

---

## Шаг 5. Пароль к noVNC

Это прямой доступ к браузеру, залогиненному в аккаунт владельца, поэтому пароль
обязателен. nginx без этого файла не стартует.

```bash
sudo htpasswd -cB /etc/nginx/threads-novnc.htpasswd admin
```

Пароль придумай длинный и передай владельцу — вводить его будет он.

**Проверка:** `sudo test -s /etc/nginx/threads-novnc.htpasswd && echo ok`

---

## Шаг 6. nginx

Конфиг генерируется из шаблона и подставляет домен и порты из `.env` — руками его
править не нужно, иначе порт разъедется с docker-compose.

Сначала посмотри, что получится:

```bash
./deploy/render-nginx.sh
```

Сертификата ещё нет, поэтому сперва ставим только HTTP-часть, чтобы certbot смог
пройти проверку домена:

```bash
sudo tee /etc/nginx/sites-available/threads-api.conf > /dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $(grep '^DOMAIN=' .env | cut -d= -f2);

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/threads-api.conf /etc/nginx/sites-enabled/threads-api.conf
sudo nginx -t && sudo systemctl reload nginx
```

**Проверка:** `nginx -t` проходит. Если он ругается на *другие* сайты — остановись
и доложи: ты задел чужой конфиг.

---

## Шаг 7. Сертификат и полный конфиг

```bash
sudo certbot --nginx -d <домен>
```

Затем заменяем конфиг на полный — с проксированием и WebSocket для noVNC:

```bash
sudo ./deploy/render-nginx.sh --install
```

Скрипт сам прогонит `nginx -t` и перезагрузит nginx только при успехе.

```bash
curl -s https://<домен>/health
curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/actions          # ожидается 401
curl -s -H "Authorization: Bearer $API_TOKEN" https://<домен>/actions | head -c 200
```

**Проверка:** `/health` отвечает по HTTPS, `/actions` без токена даёт 401, с
токеном — список действий.

---

## Шаг 8. Авторизация в Threads API — нужен человек

Дальше без владельца аккаунта не продвинуться.

Сначала в настройках приложения Threads должны быть заполнены три адреса — без
них Meta не даёт сохранить конфигурацию:

| Поле | Значение |
|---|---|
| Redirect Callback URL | `https://<домен>/oauth/callback` |
| Uninstall Callback URL | `https://<домен>/threads/uninstall` |
| Delete Callback URL | `https://<домен>/threads/delete` |

Последние два — заглушки: отвечают в формате, который ждёт проверка Meta, но
ничего не удаляют. Если приложение когда-нибудь выйдет за пределы одного своего
аккаунта, их придётся дописать по-настоящему: проверка подписи `signed_request`
и удаление сохранённого токена.

Получи ссылку авторизации и передай её владельцу:

```bash
docker compose exec api node dist/scripts/print-auth-url.js
```

Он открывает её в своём браузере под нужным аккаунтом и подтверждает доступ.
Threads вернёт его на `/oauth/callback`, сервис сам обменяет код на 60-дневный
токен и сохранит — копировать ничего не нужно.

Страница должна ответить «Готово. Токен сохранён для user_id=…».

Ссылка одноразовая и живёт 15 минут: в неё зашит `state`, который callback
гасит после первого использования. Если владелец не успел или открыл ссылку
дважды — просто выпусти новую тем же командой. Ошибка про «неизвестный или
просроченный state» означает именно это, а не поломку настройки.

**Проверка:**

```bash
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' -d '{}' \
  https://<домен>/actions/get_my_profile
```

Должен вернуться профиль с `username`. Если приходит `"Токен Threads не настроен"`
— авторизация не завершилась, вернись к началу шага.

Проверь заодно, что публикация живая (появится настоящий пост — предупреди
владельца):

```bash
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"проверка связи"}' \
  https://<домен>/post
```

---

## Шаг 9. Логин браузера — тоже нужен человек

Нужен только для лайков, подписок и чтения ленты. Публикация уже работает и без
этого шага.

Chromium не открывает один профиль дважды, поэтому сначала сервис отдаёт профиль:

```bash
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' -d '{"minutes":20}' \
  https://<домен>/browser/suspend

docker compose --profile login up -d novnc
docker compose logs -f novnc     # дождись строки про noVNC на 6080
```

Дальше действует владелец: открывает `https://<домен>/vnc/vnc.html`, вводит пароль
от шага 5, логинится в Threads в появившемся окне Chromium — вместе с 2FA, как
обычный человек.

Когда он скажет, что вошёл:

```bash
docker compose rm -sf novnc
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" https://<домен>/browser/resume
```

**Проверка:** ответ `{"ok":true,"data":{"loggedIn":true}}`.

Если `false` — вход не сохранился. Повтори шаг; не пытайся логиниться скриптом,
автоматический ввод пароля — прямой путь к блокировке аккаунта.

---

## Шаг 10. Автозапуск и финальная проверка

Контейнер поднят с `restart: unless-stopped`, так что переживёт перезагрузку, если
включён сам Docker:

```bash
sudo systemctl is-enabled docker || sudo systemctl enable docker
```

Итоговая проверка:

```bash
curl -s https://<домен>/health
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -d '{}' \
  -H 'content-type: application/json' https://<домен>/actions/get_quota
```

`/health` должен показать непустой `graph_token`. Поле `needs_login` лежит внутри
`data.browser`; `false` там будет только если пройден шаг 9 — если ты его
сознательно пропустил, `true` это норма.

---

## Что делать, когда сломается

| Симптом | Причина и что делать |
|---|---|
| `NEEDS_LOGIN` в ответах | Threads разлогинил браузер. Повтори шаг 9. Это нормально раз в несколько недель. |
| `SELECTOR_MISS` | Threads поменял вёрстку. Скриншот лежит в томе `threads-api_state`, каталог `failures/`. Чинится правкой `src/browser/selectors.ts`. |
| `"Токен Threads недействителен"` | Токен отозван. Повтори шаг 8. |
| `RATE_LIMITED` | Упёрлись в лимит. Текущие квоты: действие `get_quota`. Собственные лимиты браузера — в `.env`. |
| Порт занят при старте | `./deploy/check-ports.sh`, поменяй порт в `.env`, затем `sudo ./deploy/render-nginx.sh --install`. |
| 502 от nginx | Контейнер лежит: `docker compose ps`, `docker compose logs --tail=50 api`. |

Логи: `docker compose logs -f api`, `/var/log/nginx/threads-api.error.log`.

Обновление кода:

```bash
cd /opt/threads-api && git pull && docker compose up -d --build
```

Данные (токен, профиль браузера, журнал) живут в docker-томе `threads-api_state` и
пересборку переживают.

---

## Чего делать нельзя

- Не выставляй `API_BIND_ADDR=0.0.0.0` — API окажется в интернете без TLS.
- Не убирай basic-auth с `/vnc/` — это доступ к залогиненному аккаунту.
- Не клади `.env` и содержимое тома `state` в git: там токены и cookies.
- Не автоматизируй ввод пароля и 2FA — это ровно то, за что банят аккаунты.
