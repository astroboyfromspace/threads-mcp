import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана обязательная переменная окружения ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} должна быть числом, получено ${raw}`);
  return parsed;
}

const dataDir = resolve(process.env.DATA_DIR ?? "./var");

export const config = {
  apiToken: required("API_TOKEN"),

  threads: {
    appId: required("THREADS_APP_ID"),
    appSecret: required("THREADS_APP_SECRET"),
    redirectUri: required("THREADS_REDIRECT_URI"),
    apiBase: "https://graph.threads.net",
  },

  http: {
    host: process.env.HOST ?? "127.0.0.1",
    port: num("PORT", 8080),
  },

  paths: {
    dataDir,
    database: resolve(dataDir, "state.db"),
    browserProfile: resolve(dataDir, "profile"),
    failures: resolve(dataDir, "failures"),
  },

  media: {
    publicBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL ?? "",
  },

  browser: {
    headed: process.env.BROWSER_HEADED === "true",
    /** Сколько браузерных запросов может ждать в очереди, прежде чем начнём отдавать 429. */
    maxQueueDepth: num("BROWSER_MAX_QUEUE", 20),
    /** Разброс паузы между браузерными действиями, мс. Делает ритм непохожим на робота. */
    minDelayMs: num("BROWSER_MIN_DELAY_MS", 1500),
    maxDelayMs: num("BROWSER_MAX_DELAY_MS", 5000),
  },

  limits: {
    likesPerDay: num("LIMIT_LIKES_PER_DAY", 150),
    followsPerDay: num("LIMIT_FOLLOWS_PER_DAY", 50),
    repostsPerDay: num("LIMIT_REPOSTS_PER_DAY", 30),
    /** Поиск агрессивнее лайков: одна выдача — это десятки экранов скролла. */
    searchesPerDay: num("LIMIT_SEARCHES_PER_DAY", 30),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.paths.dataDir, config.paths.browserProfile, config.paths.failures]) {
    mkdirSync(dir, { recursive: true });
  }
}
