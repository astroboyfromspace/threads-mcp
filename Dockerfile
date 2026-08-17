# Образ Playwright уже содержит Chromium и все системные библиотеки к нему —
# собирать их вручную дольше и ошибочнее. Версия обязана совпадать с playwright
# из package.json, иначе браузер и драйвер разойдутся.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

ENV NODE_ENV=production \
    DATA_DIR=/var/lib/threads-api

WORKDIR /app

# Зависимости отдельным слоем: пересобираются только при изменении манифестов.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Отбрасываем devDependencies после сборки — в рантайме они не нужны.
RUN npm prune --omit=dev

RUN mkdir -p /var/lib/threads-api && chown -R pwuser:pwuser /var/lib/threads-api /app
USER pwuser

EXPOSE 8080
CMD ["node", "dist/src/main.js"]
