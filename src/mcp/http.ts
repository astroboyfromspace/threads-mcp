/**
 * MCP по сети: транспорт Streamable HTTP на ручке /mcp.
 *
 * Ради этого всё и затевалось — агент подключается откуда угодно по адресу и
 * токену, без ssh и без доступа к серверу. Действия выполняются прямо в этом
 * процессе, тем же браузером и той же очередью, что и запросы HTTP API.
 *
 * Режим без сессий: на каждый запрос поднимается свой сервер и свой транспорт.
 * Инструменты у нас без состояния между вызовами, а сессии на стороне сервера
 * пришлось бы чистить по таймауту и переживать перезапуск контейнера.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execute, type ActionName } from "../actions/registry.js";
import { toEnvelope, type Envelope } from "../errors.js";
import { createMcpServer } from "./server.js";

/** Выполняет действие прямо здесь и заворачивает результат в тот же конверт, что и HTTP API. */
async function callInProcess(name: ActionName, args: unknown): Promise<Envelope<unknown>> {
  try {
    return { ok: true, data: await execute(name, args) };
  } catch (err) {
    return toEnvelope(err);
  }
}

export function registerMcpRoutes(app: FastifyInstance, requireAuth: (request: FastifyRequest, reply: FastifyReply) => boolean): void {
  app.post("/mcp", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const server = createMcpServer(callInProcess);
    const transport = new StreamableHTTPServerTransport({
      // Без сессий: заголовок mcp-session-id не выдаётся и не проверяется.
      sessionIdGenerator: undefined,
      // Обычный JSON вместо SSE: ответы у нас короткие и приходят целиком, а
      // через Cloudflare и nginx простой JSON проходит без сюрпризов.
      enableJsonResponse: true,
    });

    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    // Дальше ответом распоряжается транспорт, а не Fastify.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // В режиме без сессий серверу нечего слать по своей инициативе и нечего
  // закрывать, но клиенты пробуют — отвечаем по протоколу, а не пустой 404.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      reply.code(405).header("allow", "POST");
      return {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Сервер работает без сессий: используй POST /mcp" },
        id: null,
      };
    });
  }
}
