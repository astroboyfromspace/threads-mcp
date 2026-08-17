/**
 * MCP-сервер поверх того же реестра действий, что и HTTP API.
 *
 * Запускается по stdio — так его подключает Claude Code. Никакой собственной
 * логики здесь нет: только перевод инструментов MCP в вызовы execute().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { actions, execute, type ActionName, type AnyActionDefinition } from "../actions/registry.js";
import { ensureDirs } from "../config.js";
import { getDb } from "../db.js";
import { session } from "../browser/session.js";
import { toEnvelope } from "../errors.js";

function shapeOf(definition: AnyActionDefinition): z.ZodRawShape {
  // Все действия описаны через z.object, поэтому shape всегда есть; на всякий
  // случай отдаём пустой, чтобы не падать при будущих изменениях реестра.
  return definition.input instanceof z.ZodObject ? (definition.input.shape as z.ZodRawShape) : {};
}

async function main(): Promise<void> {
  ensureDirs();
  getDb();

  const server = new McpServer({ name: "threads", version: "0.1.0" });

  for (const [name, definition] of Object.entries(actions) as Array<[ActionName, AnyActionDefinition]>) {
    server.tool(name, definition.description, shapeOf(definition), async (args: unknown) => {
      try {
        const data = await execute(name, args);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }, null, 2) }] };
      } catch (err) {
        // Ошибку отдаём как результат, а не как исключение протокола: агенту
        // нужен разбираемый код (NEEDS_LOGIN, RATE_LIMITED), чтобы решить, что делать.
        return {
          content: [{ type: "text" as const, text: JSON.stringify(toEnvelope(err), null, 2) }],
          isError: true,
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void session.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("MCP-сервер не запустился:", err);
  process.exit(1);
});
