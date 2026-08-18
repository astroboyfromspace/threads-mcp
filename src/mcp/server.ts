/**
 * Сборка MCP-сервера поверх реестра действий.
 *
 * Список инструментов один на все транспорты, а вот способ выполнить действие
 * зависит от того, где сервер запущен: внутри процесса сервиса — напрямую,
 * снаружи — запросом к HTTP API. Поэтому вызов передаётся аргументом.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { actions, type ActionName, type AnyActionDefinition } from "../actions/registry.js";
import type { Envelope } from "../errors.js";

export type ActionCaller = (name: ActionName, args: unknown) => Promise<Envelope<unknown>>;

function shapeOf(definition: AnyActionDefinition): z.ZodRawShape {
  // Все действия описаны через z.object, поэтому shape всегда есть; на всякий
  // случай отдаём пустой, чтобы не падать при будущих изменениях реестра.
  return definition.input instanceof z.ZodObject ? (definition.input.shape as z.ZodRawShape) : {};
}

export function createMcpServer(call: ActionCaller): McpServer {
  const server = new McpServer({ name: "threads", version: "0.1.0" });

  for (const [name, definition] of Object.entries(actions) as Array<[ActionName, AnyActionDefinition]>) {
    server.tool(name, definition.description, shapeOf(definition), async (args: unknown) => {
      const envelope = await call(name, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        // Ошибку отдаём как результат, а не как исключение протокола: агенту
        // нужен разбираемый код (NEEDS_LOGIN, RATE_LIMITED), чтобы решить, что делать.
        ...(envelope.ok ? {} : { isError: true }),
      };
    });
  }

  return server;
}
