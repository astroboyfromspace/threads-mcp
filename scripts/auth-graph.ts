/**
 * Первичная авторизация в Threads Graph API.
 *
 * Запуск: npm run auth
 *
 * Скрипт печатает ссылку, ты открываешь её в браузере под своим аккаунтом,
 * разрешаешь доступ, после чего Threads редиректит на THREADS_REDIRECT_URI с
 * параметром ?code=... — этот код надо вставить обратно в терминал.
 *
 * Если сервис уже поднят на твоём домене, проще пройти тот же путь через
 * GET /oauth/start — там код подхватывается автоматически.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadToken } from "../src/db.js";
import { buildAuthorizationUrl, completeOAuth } from "../src/graph/token.js";

const SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
] as const;

async function main(): Promise<void> {
  console.log("\nОткрой эту ссылку в браузере под своим аккаунтом Threads:\n");
  console.log(buildAuthorizationUrl(SCOPES));
  console.log(
    "\nПосле подтверждения тебя перебросит на redirect URI. Скопируй из адресной строки\n" +
      "значение параметра code (всё после code= и до возможного #_) и вставь сюда.\n",
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const raw = (await rl.question("code: ")).trim();
  rl.close();

  const code = raw.replace(/#_$/, "");
  if (!code) throw new Error("Код не введён");

  const stored = await completeOAuth(code);

  console.log(`\nГотово. Токен сохранён для user_id=${stored.userId}.`);
  console.log(`Действует до ${new Date(stored.expiresAt * 1000).toISOString()} и будет продлеваться автоматически.`);

  if (!loadToken()) throw new Error("Токен почему-то не записался в базу");
}

main().catch((err) => {
  console.error("\nНе получилось:", err instanceof Error ? err.message : err);
  process.exit(1);
});
