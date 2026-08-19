import type { PostCard } from "../browser/cards.js";
import type { CollectDb, CollectedPost } from "./db.js";

/** То, что прогону нужно от сервиса. Ровно два действия — больше он не зовёт. */
export type ThreadsClient = {
  readFeed(limit: number): Promise<PostCardDto[]>;
  searchPosts(query: string, limit: number): Promise<{ query: string; posts: PostCardDto[] }>;
};

// Не копия PostCard, а он сам: рукописный дубль однажды разъедется с ним при
// добавлении поля, typecheck промолчит, а better-sqlite3 неизвестный именованный
// параметр просто проигнорирует — колонка навсегда останется пустой.
// cards.ts тянет только selectors.ts и не тянет playwright, так что сборщик
// по-прежнему не тащит браузер за собой.
export type PostCardDto = PostCard;

export type CollectionReport = {
  newPosts: number;
  queriesUsed: number;
  errors: number;
  /** Карточки без разбираемой ссылки — не попали в базу, потому что дедуп опирается на url как на ключ. */
  droppedNoUrl: number;
  stoppedBy:
    | "target_reached"
    | "queries_exhausted"
    | "NEEDS_LOGIN"
    | "SELECTOR_MISS"
    | "too_many_errors"
    | "rate_limited";
};

type Deps = {
  db: CollectDb;
  client: ThreadsClient;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

type Options = { target: number; limit: number };

/** Ошибки, после которых продолжать бессмысленно: обе означают сломанный сбор, а не неудачное слово. */
const FATAL = new Set(["NEEDS_LOGIN", "SELECTOR_MISS"]);

/** Подряд идущих неудачных слов, после которых прогон явно не в порядке — например, токен неверный. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Растущая пауза перед повтором RATE_LIMITED: используется, если сервис не прислал свой retry_after. */
const RATE_LIMIT_PAUSES_MS = [60_000, 180_000, 600_000];

/**
 * Потолок паузы перед повтором RATE_LIMITED. Самый вероятный источник
 * RATE_LIMITED — наш собственный суточный лимит поиска (30 запросов при
 * списке в 82 слова), а сервис в этом случае отдаёт retry_after порядка
 * часа. Ждать час ради одного слова, а потом ещё столько же ради следующих
 * четырёх, — бессмысленно: квота не восстановится раньше завтра. Короткие
 * паузы (переполненная очередь браузера — retry_after порядка 30 секунд)
 * этого потолка не задевают и по-прежнему приводят к повтору.
 */
const RATE_LIMIT_PAUSE_CAP_MS = 15 * 60 * 1_000;

/** Сообщение ошибки: без него в логе остаётся голый код, по которому нечего чинить. */
const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? `: ${error.message}` : "";

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL";

/** Сервис может прислать свою рекомендованную паузу в секундах — она приоритетнее нашей. */
const retryAfterOf = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("retry_after" in error)) return undefined;
  const value = (error as { retry_after: unknown }).retry_after;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** Сигнал «квота исчерпана на сегодня»: не повод ждать, а повод закончить весь прогон. */
class QuotaExhaustedError extends Error {
  constructor(word: string, retryAfterSeconds: number) {
    super(
      `${word}: суточная квота поиска исчерпана (сервис просит подождать ${Math.round(retryAfterSeconds / 60)} мин) — ` +
        "продолжать сегодня нечем",
    );
    this.name = "QuotaExhaustedError";
  }
}

/**
 * Зовёт поиск с повтором на RATE_LIMITED: до трёх повторов сверх исходного
 * захода, с растущей паузой 60/180/600 секунд — или с паузой из retry_after
 * ответа, если сервис её прислал. Пауза в любом случае не превышает
 * RATE_LIMIT_PAUSE_CAP_MS. Если retry_after сам по себе больше этого
 * потолка — это не короткая заминка, а исчерпанная суточная квота, и
 * повторять нет смысла: бросаем QuotaExhaustedError, не сделав ни одной
 * попытки повтора. После исчерпания обычных повторов бросает последнюю
 * ошибку — слово считается неудачным по общим правилам.
 */
async function searchWithRetry(
  client: ThreadsClient,
  word: string,
  limit: number,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<{ query: string; posts: PostCardDto[] }> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await client.searchPosts(word, limit);
    } catch (error) {
      if (codeOf(error) !== "RATE_LIMITED") throw error;

      const retryAfterSeconds = retryAfterOf(error);
      if (retryAfterSeconds !== undefined && retryAfterSeconds * 1_000 > RATE_LIMIT_PAUSE_CAP_MS) {
        throw new QuotaExhaustedError(word, retryAfterSeconds);
      }

      if (retry >= RATE_LIMIT_PAUSES_MS.length) throw error;

      const wanted = retryAfterSeconds !== undefined ? retryAfterSeconds * 1_000 : RATE_LIMIT_PAUSES_MS[retry]!;
      const pauseMs = Math.min(wanted, RATE_LIMIT_PAUSE_CAP_MS);
      log(`${word}: RATE_LIMITED, повтор через ${Math.round(pauseMs / 1_000)}с`);
      await sleep(pauseMs);
    }
  }
}

/**
 * Ссылки в выдаче Threads несут трекинговые параметры (`?xmt=…`, `igshid=…` и
 * подобные), разные при каждом показе одного и того же поста. Если положить их
 * в PRIMARY KEY как есть, один пост ляжет несколькими строками, и обещанный
 * «дедуп по ссылке бесплатно» перестанет работать. Оставляем origin + pathname,
 * query и hash отбрасываем.
 */
function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

/** Пост без разбираемой ссылки в датасет не годится: дедуп опирается на неё как на ключ. */
function toStored(card: PostCardDto, source: "search" | "feed", foundBy: string | null): CollectedPost | null {
  if (!card.url) return null;
  const url = normalizeUrl(card.url);
  if (!url) return null;
  return { ...card, url, source, foundBy };
}

/** Отделяет карточки без разбираемой ссылки, чтобы их не терять беззвучно — отчёт о них знает. */
function splitStored(
  cards: PostCardDto[],
  source: "search" | "feed",
  foundBy: string | null,
): { stored: CollectedPost[]; droppedNoUrl: number } {
  const stored: CollectedPost[] = [];
  let droppedNoUrl = 0;
  for (const card of cards) {
    const post = toStored(card, source, foundBy);
    if (post) stored.push(post);
    else droppedNoUrl += 1;
  }
  return { stored, droppedNoUrl };
}

export async function runCollection(deps: Deps, options: Options): Promise<CollectionReport> {
  const { db, client, sleep } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? (() => undefined);

  let newPosts = 0;
  let errors = 0;
  let queriesUsed = 0;
  let droppedNoUrl = 0;

  // Лента идёт первой и ровно одним заходом. Она персонализирована, и при
  // большом объёме заполнила бы датасет десятком одних и тех же авторов.
  try {
    const feed = await client.readFeed(options.limit);
    const { stored, droppedNoUrl: feedDropped } = splitStored(feed, "feed", null);
    const added = db.insertPosts(stored, now());
    newPosts += added;
    droppedNoUrl += feedDropped;
    log(`лента: +${added}`);
  } catch (error) {
    const code = codeOf(error);
    if (FATAL.has(code)) return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: code as "NEEDS_LOGIN" };
    errors += 1;
    log(`лента: ошибка ${code}${messageOf(error)}`);
  }

  if (newPosts >= options.target) {
    return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: "target_reached" };
  }

  // Берём все слова разом в порядке ротации: внутри прогона порядок меняться не
  // должен, иначе одно и то же слово может попасться дважды.
  const words = db.nextQueries(1_000);

  // Подряд идущих неудачных слов: успешный заход обнуляет счётчик. Неверный
  // токен иначе сжигает всю ротацию — 82 слова получают свежий last_run_at и
  // ноль постов, — поэтому прерываемся раньше.
  let consecutiveErrors = 0;

  for (const [index, word] of words.entries()) {
    try {
      const found = await searchWithRetry(client, word, options.limit, sleep, log);
      const { stored, droppedNoUrl: wordDropped } = splitStored(found.posts, "search", word);

      const added = db.insertPosts(stored, now());
      newPosts += added;
      droppedNoUrl += wordDropped;
      queriesUsed += 1;
      consecutiveErrors = 0;
      db.recordRun(word, { newPosts: added }, now());
      log(`${word}: +${added} (всего ${newPosts})`);
    } catch (error) {
      if (error instanceof QuotaExhaustedError) {
        log(error.message);
        return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: "rate_limited" };
      }

      const code = codeOf(error);
      if (FATAL.has(code)) {
        return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: code as "NEEDS_LOGIN" | "SELECTOR_MISS" };
      }
      errors += 1;
      queriesUsed += 1;
      consecutiveErrors += 1;
      // Не recordRun: last_run_at и runs остаются как были, иначе неудачное
      // слово уедет в конец очереди ротации, ничего не собрав.
      db.recordError(word, code, now());
      log(`${word}: ошибка ${code}${messageOf(error)}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: "too_many_errors" };
      }
    }

    if (newPosts >= options.target) {
      return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: "target_reached" };
    }

    // Пауза между запросами, а не после последнего: ждать перед выходом незачем.
    if (index < words.length - 1) {
      await sleep(5_000 + Math.floor(Math.random() * 10_000));
    }
  }

  return { newPosts, queriesUsed, errors, droppedNoUrl, stoppedBy: "queries_exhausted" };
}
