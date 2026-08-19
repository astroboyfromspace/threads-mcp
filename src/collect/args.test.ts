import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("применяет значения по умолчанию без аргументов", () => {
    expect(parseArgs([])).toEqual({
      exportTo: undefined,
      target: 1_000,
      limit: 100,
      queries: "src/collect/queries-en.txt",
    });
  });

  it("читает переданные значения", () => {
    const parsed = parseArgs(["--target", "500", "--limit", "50", "--queries", "words.txt"]);
    expect(parsed).toMatchObject({ target: 500, limit: 50, queries: "words.txt" });
  });

  it("читает путь экспорта", () => {
    expect(parseArgs(["--export", "dataset.csv"]).exportTo).toBe("dataset.csv");
  });

  // Забытое имя файла раньше молча уводило в живой сбор — расход суточной
  // квоты и риск блокировки аккаунта без разрешения на то владельца.
  it("--export без пути — ошибка, а не переход к сбору", () => {
    expect(() => parseArgs(["--export"])).toThrow(ArgsError);
  });

  it("--export перед другим флагом — тоже без пути", () => {
    expect(() => parseArgs(["--export", "--target", "10"])).toThrow(ArgsError);
  });

  // Опечатка в значении раньше давала NaN, и прогон никогда не останавливался
  // по цели.
  it("нечисловой --target — ошибка", () => {
    expect(() => parseArgs(["--target", "abc"])).toThrow(ArgsError);
  });

  it("--target без значения — используется значение по умолчанию, а не ошибка", () => {
    expect(parseArgs(["--target", "--limit", "10"]).target).toBe(1_000);
  });

  it("дробный --target — ошибка", () => {
    expect(() => parseArgs(["--target", "10.5"])).toThrow(ArgsError);
  });

  it("нулевой и отрицательный --target — ошибка", () => {
    expect(() => parseArgs(["--target", "0"])).toThrow(ArgsError);
    expect(() => parseArgs(["--target", "-5"])).toThrow(ArgsError);
  });

  it("нечисловой --limit — ошибка", () => {
    expect(() => parseArgs(["--limit", "many"])).toThrow(ArgsError);
  });
});
