# Образ Playwright уже содержит Chromium и все системные библиотеки к нему —
# собирать их вручную дольше и ошибочнее. Версия обязана совпадать с playwright
# из package.json, иначе браузер и драйвер разойдутся.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    DATA_DIR=/var/lib/threads-api

WORKDIR /app

# Зависимости отдельным слоем: пересобираются только при изменении манифестов.
COPY package.json package-lock.json ./
# --include=dev обязателен: выше задан NODE_ENV=production, из-за него npm сам
# подставляет omit=dev и не ставит typescript, а без tsc падает сборка ниже.
# На размер образа это не влияет — devDependencies отбрасывает npm prune.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY deploy/start.sh ./deploy/start.sh
RUN npm run build

# Отбрасываем devDependencies после сборки — в рантайме они не нужны.
RUN npm prune --omit=dev

RUN mkdir -p /var/lib/threads-api && chown -R pwuser:pwuser /var/lib/threads-api /app
USER pwuser

EXPOSE 8080

# Не сам node, а обёртка: она поднимает виртуальный экран, на котором работает
# браузер в настоящем окне вместо headless-режима. Подробности — в скрипте.
CMD ["/app/deploy/start.sh"]
