/**
 * MCP-сервер поверх того же реестра действий, что и HTTP API.
 *
 * Запускается по stdio — так его подключает агент. Собственной логики здесь
 * нет: только перевод инструментов MCP в вызовы HTTP API.
 *
 * Почему через HTTP, а не напрямую через execute(): браузерный профиль Chromium
 * не рассчитан на два процесса сразу, а сервис в контейнере держит его открытым
 * постоянно. Ходили бы напрямую — рядом поднялся бы второй Chromium на той же
 * папке профиля, и рано или поздно два экземпляра побили бы cookies, после чего
 * логиниться в Threads пришлось бы заново руками через noVNC. Заодно все агенты
 * встают в общую очередь сервиса и живут под общими суточными лимитами.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { actions, type ActionName, type AnyActionDefinition } from "../actions/registry.js";
import { config } from "../config.js";
import { ActionError, toEnvelope, type Envelope } from "../errors.js";

/**
 * Адрес сервиса. По умолчанию — петлевой интерфейс: MCP запускают внутри того же
 * контейнера (docker exec), где сервис слушает 8080.
 */
const apiUrl = (process.env.THREADS_API_URL ?? `http://127.0.0.1:${config.http.port}`).replace(/\/+$/, "");

function shapeOf(definition: AnyActionDefinition): z.ZodRawShape {
  // Все действия описаны через z.object, поэтому shape всегда есть; на всякий
  // случай отдаём пустой, чтобы не падать при будущих изменениях реестра.
  return definition.input instanceof z.ZodObject ? (definition.input.shape as z.ZodRawShape) : {};
}

/** Зовёт действие у сервиса и возвращает его конверт как есть. */
async function callAction(name: ActionName, args: unknown): Promise<Envelope<unknown>> {
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
  const server = new McpServer({ name: "threads", version: "0.1.0" });

  for (const [name, definition] of Object.entries(actions) as Array<[ActionName, AnyActionDefinition]>) {
    server.tool(name, definition.description, shapeOf(definition), async (args: unknown) => {
      const envelope = await callAction(name, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        // Ошибку отдаём как результат, а не как исключение протокола: агенту
        // нужен разбираемый код (NEEDS_LOGIN, RATE_LIMITED), чтобы решить, что делать.
        ...(envelope.ok ? {} : { isError: true }),
      };
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => process.exit(0));
  }
}

main().catch((err) => {
  console.error("MCP-сервер не запустился:", err);
  process.exit(1);
});
