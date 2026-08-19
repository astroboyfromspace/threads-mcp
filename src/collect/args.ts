/**
 * Разбор аргументов `scripts/collect.ts` — вынесено в отдельный модуль, чтобы
 * покрыть тестами: ошибка здесь либо тратит суточную квоту вслепую (забытое
 * имя файла у `--export` тихо уводит в живой сбор), либо не даёт прогону
 * остановиться по цели (`--target` с опечаткой в значении даёт NaN).
 */

export class ArgsError extends Error {}

export type ParsedArgs = {
  /** Путь для экспорта; undefined — значит, режим сбора, а не выгрузки. */
  exportTo: string | undefined;
  target: number;
  limit: number;
  queries: string;
};

/**
 * Значение опции. Опция без значения (флаг последний в списке, либо следом
 * идёт другой `--флаг`) считается отсутствующей — value, начинающееся с
 * `--`, никогда не принадлежит предыдущей опции.
 */
function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function positiveInt(argv: readonly string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgsError(`--${name} должен быть конечным положительным целым числом, получено «${raw}»`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // `--export` присутствует, но без пути — это не «сбор без выгрузки», а
  // ошибка: молчаливый переход к живому сбору тратит суточную квоту и рискует
  // блокировкой аккаунта, когда этого никто не просил.
  if (argv.includes("--export") && option(argv, "export") === undefined) {
    throw new ArgsError("--export требует пути к файлу");
  }

  return {
    exportTo: option(argv, "export"),
    target: positiveInt(argv, "target", 1_000),
    limit: positiveInt(argv, "limit", 100),
    queries: option(argv, "queries") ?? "src/collect/queries-en.txt",
  };
}
