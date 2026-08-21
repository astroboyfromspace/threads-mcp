import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actions, type AnyActionDefinition } from "../actions/registry.js";
import { shapeOf } from "./server.js";

const entries = Object.entries(actions) as Array<[string, AnyActionDefinition]>;

describe("параметры инструментов MCP", () => {
  // Пустая схема выглядит как инструмент без аргументов: агент зовёт его без
  // полей и получает «text: Required» от бэкенда, не понимая, что передавать.
  it.each(entries)("%s отдаёт все поля своей схемы", (_name, definition) => {
    let schema: z.ZodTypeAny = definition.input;
    while (schema instanceof z.ZodEffects) schema = schema.innerType();
    const expected = schema instanceof z.ZodObject ? Object.keys(schema.shape as object) : [];

    expect(Object.keys(shapeOf(definition))).toEqual(expected);
  });

  it("не теряет поля из-за .refine() поверх объекта", () => {
    const refined = z.object({ url: z.string().optional(), text: z.string() }).refine(() => true);

    expect(Object.keys(shapeOf({ input: refined } as AnyActionDefinition))).toEqual(["url", "text"]);
  });
});
