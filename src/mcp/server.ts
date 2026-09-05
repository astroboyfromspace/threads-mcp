/**
 * Сборка MCP-сервера поверх реестра действий.
 *
 * Список инструментов один на все транспорты, а вот способ выполнить действие
 * зависит от того, где сервер запущен: внутри процесса сервиса — напрямую,
 * снаружи — запросом к HTTP API. Поэтому вызов передаётся аргументом.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { actions, type ActionName, type AnyActionDefinition, type Driver } from "../actions/registry.js";
import type { Envelope } from "../errors.js";

export type ActionCaller = (name: ActionName, args: unknown) => Promise<Envelope<unknown>>;

/**
 * Поля действия для описания инструмента.
 *
 * Схема с .refine() — это ZodEffects поверх объекта, а не сам объект, и без
 * разворачивания агент получал бы инструмент без единого параметра: вызвать
 * его нечем, а бэкенд при этом требует поля. Разворачиваем до объекта.
 */
export function shapeOf(definition: AnyActionDefinition): z.ZodRawShape {
  let schema: z.ZodTypeAny = definition.input;
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  // Все действия описаны через z.object, поэтому shape всегда есть; на всякий
  // случай отдаём пустой, чтобы не падать при будущих изменениях реестра.
  return schema instanceof z.ZodObject ? (schema.shape as z.ZodRawShape) : {};
}

/**
 * Пока что показываем агенту только браузерные инструменты.
 *
 * Действия через официальный Graph API Meta (driver: "graph" — publish_post,
 * reply_to_post, list_my_posts, list_my_replies, get_conversation, delete_post,
 * get_quota, get_my_profile) временно скрыты из MCP. В реестре они остались и
 * по HTTP (POST /actions/<name>) по-прежнему доступны — чтобы вернуть их
 * агенту, достаточно убрать эту проверку.
 */
const EXPOSED_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["browser"]);

export function createMcpServer(call: ActionCaller): McpServer {
  const server = new McpServer({ name: "threads", version: "0.1.0" });

  for (const [name, definition] of Object.entries(actions) as Array<[ActionName, AnyActionDefinition]>) {
    if (!EXPOSED_DRIVERS.has(definition.driver)) continue;

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
