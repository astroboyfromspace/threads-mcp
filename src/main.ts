import { config, ensureDirs } from "./config.js";
import { getDb } from "./db.js";
import { buildServer } from "./http/server.js";
import { session } from "./browser/session.js";

const LOGIN_CHECK_INTERVAL_MS = 30 * 60_000;

async function main(): Promise<void> {
  ensureDirs();
  getDb();

  const app = buildServer();
  await app.listen({ host: config.http.host, port: config.http.port });

  // Первая проверка сессии — в фоне: браузер стартует несколько секунд, и ждать
  // его ради готовности HTTP-слоя незачем. Graph-действия работают и без браузера.
  void checkLoginQuietly(app.log);
  const timer = setInterval(() => void checkLoginQuietly(app.log), LOGIN_CHECK_INTERVAL_MS);
  timer.unref();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info(`Получен ${signal}, останавливаюсь`);
        clearInterval(timer);
        await app.close().catch(() => undefined);
        await session.close();
        process.exit(0);
      })();
    });
  }
}

async function checkLoginQuietly(log: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
  try {
    const result = await session.checkLogin();
    if (result.loggedIn) log.info("Браузерная сессия Threads активна");
    else log.warn("Браузерная сессия разлогинена — зайди через noVNC и авторизуйся вручную");
  } catch (err) {
    log.warn(`Не удалось проверить браузерную сессию: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error("Сервис не запустился:", err);
  process.exit(1);
});
