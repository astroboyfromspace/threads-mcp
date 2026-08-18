/**
 * MCP по stdio — для случая, когда агент запускается на том же сервере.
 *
 * Основной способ подключения другой: сетевой, POST /mcp у самого сервиса (см.
 * src/mcp/http.ts). Здесь остаётся локальный вариант для отладки и для агентов,
 * которым удобнее порождать процесс, чем ходить по сети.
 *
 * Действия не выполняются здесь, а уходят в HTTP API. Chromium не рассчитан на
 * два процесса с одной папкой профиля, а сервис в контейнере держит браузер
 * открытым постоянно: выполняй этот процесс действия сам, рядом поднялся бы
 * второй Chromium на том же профиле, и рано или поздно два экземпляра побили бы
 * cookies — логиниться в Threads пришлось бы заново руками через noVNC.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";
import type { ActionName } from "../actions/registry.js";
import { ActionError, toEnvelope, type Envelope } from "../errors.js";
import { createMcpServer } from "./server.js";

/**
 * Адрес сервиса. По умолчанию — петлевой интерфейс: MCP запускают внутри того же
 * контейнера (docker exec), где сервис слушает 8080.
 */
const apiUrl = (process.env.THREADS_API_URL ?? `http://127.0.0.1:${config.http.port}`).replace(/\/+$/, "");

/** Зовёт действие у сервиса и возвращает его конверт как есть. */
async function callOverHttp(name: ActionName, args: unknown): Promise<Envelope<unknown>> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/actions/${name}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch (err) {
    return toEnvelope(
      new ActionError(
        "UPSTREAM",
        `Сервис threads-api не отвечает по ${apiUrl} (${err instanceof Error ? err.message : String(err)}). ` +
          "Проверь, поднят ли контейнер: docker compose ps",
        { retryable: true, retryAfterSeconds: 30 },
      ),
    );
  }

  // Тело читаем текстом: у 401 и у сетевых прокси оно может оказаться не JSON,
  // и падать на разборе ровно там, где надо объяснить причину, — плохая идея.
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Envelope<unknown>;
  } catch {
    return toEnvelope(
      new ActionError("UPSTREAM", `Сервис ответил ${response.status}, но не конвертом: ${raw.slice(0, 300)}`, {
        retryable: false,
      }),
    );
  }
}

async function main(): Promise<void> {
  const server = createMcpServer(callOverHttp);
  await server.connect(new StdioServerTransport());

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => process.exit(0));
  }
}

main().catch((err) => {
  console.error("MCP-сервер не запустился:", err);
  process.exit(1);
});
