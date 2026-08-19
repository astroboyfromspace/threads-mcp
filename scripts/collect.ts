/**
 * Сборщик датасета: гоняет действия сервиса по списку слов и копит результат.
 *
 * Живёт снаружи сервиса намеренно. Выдача поиска — это скролл в живой странице,
 * возобновить его между запросами нельзя, поэтому объём набирается количеством
 * запросов, а такой цикл — обычный for с паузами. Держать ради него машину
 * состояний внутри сервиса незачем.
 *
 *   npm run collect -- --target 1000
 *   npm run collect -- --export dataset.csv
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toCsv } from "../src/collect/csv.js";
import { openCollectDb } from "../src/collect/db.js";
import { runCollection, type PostCardDto, type ThreadsClient } from "../src/collect/runner.js";

const args = process.argv.slice(2);

function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const dataDir = resolve(process.env.DATA_DIR ?? "./var");
const dbPath = resolve(dataDir, "collect.sqlite");
const db = openCollectDb(dbPath);

const exportTo = option("export");
if (exportTo) {
  const posts = db.allPosts();
  writeFileSync(exportTo, toCsv(posts), "utf8");
  console.log(`Выгружено ${posts.length} постов в ${exportTo}`);
  db.close();
  process.exit(0);
}

const baseUrl = process.env.THREADS_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.API_TOKEN;
if (!token) {
  console.error("Не задан API_TOKEN — сервис не пустит.");
  process.exit(1);
}

/** Ходит в сервис тем же способом, что и любой другой клиент: POST /actions/:name. */
async function call<T>(action: string, input: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/actions/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  const payload = (await response.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };

  if (!payload.ok) {
    throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  }
  return payload.data;
}

const client: ThreadsClient = {
  readFeed: (limit) => call<PostCardDto[]>("read_feed", { limit }),
  searchPosts: (query, limit) => call<{ query: string; posts: PostCardDto[] }>("search_posts", { query, limit }),
};

const wordsFile = resolve(option("queries", "src/collect/queries-en.txt")!);
const words = readFileSync(wordsFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

db.syncQueries(words);

const target = Number(option("target", "1000"));
const limit = Number(option("limit", "100"));

console.log(`Старт: цель ${target} новых постов, ${words.length} слов, база ${dbPath}`);

const report = await runCollection(
  {
    db,
    client,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (message) => console.log(message),
  },
  { target, limit },
);

console.log(
  `Готово: +${report.newPosts} новых, запросов ${report.queriesUsed}, ошибок ${report.errors}, ` +
    `остановка — ${report.stoppedBy}. Всего в базе ${db.totalPosts()}.`,
);

if (report.stoppedBy === "NEEDS_LOGIN") {
  console.error("Сессия Threads истекла — нужен ручной вход через noVNC, см. README.");
}
if (report.stoppedBy === "SELECTOR_MISS") {
  console.error("Threads изменил вёрстку — смотри скриншот в var/failures/ и чини src/browser/selectors.ts.");
}

db.close();
