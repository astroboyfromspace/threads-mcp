# Сбор датасета постов: план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: используй
> superpowers:subagent-driven-development (рекомендуется) или
> superpowers:executing-plans, чтобы выполнять план задача за задачей. Шаги
> размечены чекбоксами (`- [ ]`).

**Цель:** собрать датасет примерно из 10 000 англоязычных постов Threads за
десяток коротких прогонов и выгрузить его в CSV.

**Архитектура:** сервис получает одно новое браузерное действие `search_posts`;
карточка поста учится отдавать время, счётчики и признак медиа; внешний скрипт
`scripts/collect.ts` крутит цикл по списку частотных английских слов, ходит в
сервис по HTTP и копит результат в отдельной `var/collect.sqlite`. Вся логика,
не зависящая от живой вёрстки Threads, вынесена в чистые функции и покрыта
тестами.

**Стек:** Node 22, TypeScript (NodeNext, strict), Playwright, better-sqlite3,
zod, Fastify, vitest.

**Спека:** `docs/plans/2026-08-19-threads-collect-design.md` — план ссылается на
неё и не повторяет обоснований; исполнителю нужно прочитать оба документа.

## Общие ограничения

- Язык кода и комментариев — русский, как во всём проекте. Комментарий
  объясняет «почему», а не «что».
- Все зацепки за вёрстку Threads живут только в `src/browser/selectors.ts`.
  Ни один селектор не пишется по месту в `actions.ts`.
- Браузерные действия тестами не покрываются. Покрывается всё, что от вёрстки
  не зависит: чистые функции разбора, БД сборщика, CSV.
- Модули ESM: импорты внутри проекта всегда с расширением `.js`
  (`./cards.js`), даже для `.ts`-файлов.
- `noUncheckedIndexedAccess: true` — обращение по индексу даёт `T | undefined`,
  это надо учитывать (`arr[0]!` или проверка).
- Ответ действия всегда проходит через реестр `src/actions/registry.ts`: и
  REST, и MCP читают его же. Отдельных маршрутов не заводить.
- Формат ошибок — `ActionError` с кодом из `src/errors.ts`. Новых кодов не
  добавляем.
- Тесты запускаются `npm test`, типы — `npm run typecheck`. Обе команды должны
  быть зелёными перед каждым коммитом.
- Суточный лимит `search_posts` — 30 успешных вызовов
  (`LIMIT_SEARCHES_PER_DAY`).
- Сборщик пишет в `var/collect.sqlite`; сервисную `var/state.db` он не
  открывает никогда.

---

### Задача 1: Чистый разбор счётчиков и медиа

**Файлы:**
- Создать: `src/browser/cards.ts`
- Создать: `src/browser/cards.test.ts`

**Интерфейсы:**
- Использует: ничего из предыдущих задач.
- Отдаёт: `parseCount(label: string | null): number | null`,
  `classifyMedia(counts: { images: number; videos: number } | null): { media: MediaKind | null; mediaCount: number | null }`,
  тип `MediaKind = "none" | "image" | "video" | "mixed"`.

Threads пишет счётчики в подпись доступности кнопки и сокращает большие числа.
Английский интерфейс даёт `1.2K`, русский — `1,2 тыс.`; язык зависит от
настроек аккаунта, поэтому понимать надо оба. Разделитель разбирается по
правилу: если есть суффикс масштаба, точка или запятая перед ним — десятичная
(`1.2K` = 1200); если суффикса нет, они разделяют тысячи (`1,234` = 1234).

- [ ] **Шаг 1: Написать падающий тест**

Создать `src/browser/cards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyMedia, parseCount } from "./cards.js";

describe("parseCount", () => {
  it("читает голое число", () => {
    expect(parseCount("Like 12")).toBe(12);
  });

  it("отделяет число от подписи кнопки на любом языке", () => {
    expect(parseCount("Unlike 3")).toBe(3);
    expect(parseCount("Не нравится 3")).toBe(3);
  });

  it("разворачивает сокращения", () => {
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("1,2 тыс.")).toBe(1200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("2,5 млн")).toBe(2_500_000);
  });

  it("без суффикса считает разделители тысячными", () => {
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("12 345")).toBe(12_345);
  });

  // Кнопка без числа значит ноль: у поста без лайков счётчика в подписи нет.
  it("подпись без числа — это ноль", () => {
    expect(parseCount("Like")).toBe(0);
    expect(parseCount("Нравится")).toBe(0);
  });

  // А вот отсутствие самой кнопки — это «не знаем», и путать его с нулём нельзя.
  it("отсутствие подписи — null, а не ноль", () => {
    expect(parseCount(null)).toBeNull();
    expect(parseCount("   ")).toBeNull();
  });
});

describe("classifyMedia", () => {
  it("пустая карточка — none", () => {
    expect(classifyMedia({ images: 0, videos: 0 })).toEqual({ media: "none", mediaCount: 0 });
  });

  it("считает картинки", () => {
    expect(classifyMedia({ images: 2, videos: 0 })).toEqual({ media: "image", mediaCount: 2 });
  });

  it("считает видео", () => {
    expect(classifyMedia({ images: 0, videos: 1 })).toEqual({ media: "video", mediaCount: 1 });
  });

  it("картинки вместе с видео — mixed", () => {
    expect(classifyMedia({ images: 1, videos: 1 })).toEqual({ media: "mixed", mediaCount: 2 });
  });

  // Если отличить медиа поста от аватара не удалось, честный ответ — «не знаю».
  it("неопознанная карточка — null, а не none", () => {
    expect(classifyMedia(null)).toEqual({ media: null, mediaCount: null });
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Запустить: `npx vitest run src/browser/cards.test.ts`
Ожидание: FAIL — `Failed to resolve import "./cards.js"`.

- [ ] **Шаг 3: Реализовать**

Создать `src/browser/cards.ts`:

```ts
/**
 * Разбор карточки поста — всё, что не требует живой страницы.
 *
 * Вынесено из actions.ts намеренно: браузерные действия тестами не покрываются,
 * а вот превращение «1,2 тыс.» в 1200 покрыть обязано — ошибка здесь тихо
 * испортит весь датасет и обнаружится, когда по нему уже посчитают статистику.
 */

export type MediaKind = "none" | "image" | "video" | "mixed";

const SCALES: Array<{ pattern: RegExp; factor: number }> = [
  { pattern: /^(k|тыс\.?)/i, factor: 1_000 },
  { pattern: /^(m|млн)/i, factor: 1_000_000 },
  { pattern: /^(b|млрд)/i, factor: 1_000_000_000 },
];

/**
 * Достаёт число из подписи доступности: «Unlike 3» → 3, «1.2K» → 1200.
 *
 * Подпись без числа — ноль: у поста без лайков Threads не рисует счётчик рядом
 * с кнопкой. Отсутствие самой подписи — null: кнопки не нашли, и это другое.
 */
export function parseCount(label: string | null): number | null {
  if (!label || !label.trim()) return null;

  const match = /(\d[\d., \s]*)\s*(k|m|b|тыс\.?|млн|млрд)?/i.exec(label);
  if (!match) return 0;

  const digits = match[1]!.trim();
  const suffix = match[2];
  const scale = suffix ? SCALES.find((item) => item.pattern.test(suffix))?.factor ?? 1 : 1;

  if (scale === 1) {
    // Без суффикса точка, запятая и пробел разделяют тысячи: «1,234» — это 1234.
    const value = Number(digits.replace(/[., \s]/g, ""));
    return Number.isFinite(value) ? value : 0;
  }

  // С суффиксом тот же знак — уже десятичный: «1,2 тыс.» — это 1200.
  const value = Number(digits.replace(/[ \s]/g, "").replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * scale) : 0;
}

/** Сводит счёт картинок и видео к одному признаку. null на входе — «определить не смогли». */
export function classifyMedia(counts: { images: number; videos: number } | null): {
  media: MediaKind | null;
  mediaCount: number | null;
} {
  if (!counts) return { media: null, mediaCount: null };

  const { images, videos } = counts;
  const mediaCount = images + videos;

  if (images > 0 && videos > 0) return { media: "mixed", mediaCount };
  if (videos > 0) return { media: "video", mediaCount };
  if (images > 0) return { media: "image", mediaCount };
  return { media: "none", mediaCount: 0 };
}
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Запустить: `npx vitest run src/browser/cards.test.ts`
Ожидание: PASS, 11 тестов.

- [ ] **Шаг 5: Проверить типы и закоммитить**

```bash
npm run typecheck
git add src/browser/cards.ts src/browser/cards.test.ts
git commit -m "Разбор счётчиков и медиа в карточке поста"
```

---

### Задача 2: Сборка карточки из сырых данных страницы

**Файлы:**
- Изменить: `src/browser/cards.ts`
- Изменить: `src/browser/cards.test.ts`

**Интерфейсы:**
- Использует: `parseCount`, `classifyMedia`, `MediaKind` из задачи 1.
- Отдаёт: типы `RawCard` и `PostCard`, функцию
  `buildCard(raw: RawCard): PostCard | null` и `authorFromUrl(url: string | null): string | null`.

`PostCard` — расширенная замена нынешнему `FeedItem`. Старые поля сохраняются
как есть, чтобы `read_feed`, `read_profile` и `read_replies` продолжили
работать без изменения формы ответа.

- [ ] **Шаг 1: Написать падающий тест**

Дописать в конец `src/browser/cards.test.ts`, а импорт из первой строки файла
расширить до `import { authorFromUrl, buildCard, classifyMedia, parseCount } from "./cards.js";`:

```ts
const RAW = {
  href: "/@someone/post/abc123",
  text: "просто пост",
  datetime: "2026-08-18T10:00:00.000Z",
  likeLabel: "Like 5",
  replyLabel: "Reply 2",
  repostLabel: "Repost",
  media: { images: 1, videos: 0 },
};

describe("buildCard", () => {
  it("собирает карточку целиком", () => {
    expect(buildCard(RAW)).toEqual({
      author: "someone",
      url: "https://www.threads.net/@someone/post/abc123",
      text: "просто пост",
      publishedAt: "2026-08-18T10:00:00.000Z",
      likes: 5,
      replies: 2,
      reposts: 0,
      media: "image",
      mediaCount: 1,
    });
  });

  it("достраивает относительную ссылку до абсолютной", () => {
    expect(buildCard(RAW)?.url).toBe("https://www.threads.net/@someone/post/abc123");
  });

  // Ответы в ленте бывают без пермалинка — это не повод терять сам текст.
  it("переживает отсутствие ссылки", () => {
    const card = buildCard({ ...RAW, href: null });
    expect(card?.url).toBeNull();
    expect(card?.author).toBeNull();
    expect(card?.text).toBe("просто пост");
  });

  it("пустой контейнер карточкой не считается", () => {
    expect(buildCard({ ...RAW, text: "   " })).toBeNull();
  });

  it("не выдумывает время, когда его нет", () => {
    expect(buildCard({ ...RAW, datetime: null })?.publishedAt).toBeNull();
  });
});

describe("authorFromUrl", () => {
  it("достаёт автора из пермалинка", () => {
    expect(authorFromUrl("https://www.threads.net/@someone/post/abc")).toBe("someone");
  });

  it("на чужой ссылке молчит", () => {
    expect(authorFromUrl("https://www.threads.net/search?q=x")).toBeNull();
    expect(authorFromUrl(null)).toBeNull();
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Запустить: `npx vitest run src/browser/cards.test.ts`
Ожидание: FAIL — `buildCard is not a function` (импорт не разрешается).

- [ ] **Шаг 3: Реализовать**

Дописать в `src/browser/cards.ts`:

```ts
import { URLS } from "./selectors.js";

/** Сырьё, снятое со страницы: строки как есть, без интерпретации. */
export type RawCard = {
  href: string | null;
  text: string;
  datetime: string | null;
  likeLabel: string | null;
  replyLabel: string | null;
  repostLabel: string | null;
  media: { images: number; videos: number } | null;
};

export type PostCard = {
  author: string | null;
  url: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  media: MediaKind | null;
  mediaCount: number | null;
};

export function authorFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /\/@([^/]+)\/post\//.exec(url);
  return match?.[1] ?? null;
}

/** Превращает сырьё в карточку. null — если в контейнере не было текста. */
export function buildCard(raw: RawCard): PostCard | null {
  const text = raw.text.trim();
  if (!text) return null;

  const url = raw.href ? new URL(raw.href, URLS.home).toString() : null;
  const { media, mediaCount } = classifyMedia(raw.media);

  return {
    author: authorFromUrl(url),
    url,
    text,
    publishedAt: raw.datetime,
    likes: parseCount(raw.likeLabel),
    replies: parseCount(raw.replyLabel),
    reposts: parseCount(raw.repostLabel),
    media,
    mediaCount,
  };
}
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Запустить: `npx vitest run src/browser/cards.test.ts`
Ожидание: PASS, 18 тестов.

- [ ] **Шаг 5: Проверить типы и закоммитить**

```bash
npm run typecheck
git add src/browser/cards.ts src/browser/cards.test.ts
git commit -m "Сборка карточки поста из сырых данных страницы"
```

---

### Задача 3: Карточка на живой странице

**Файлы:**
- Изменить: `src/browser/selectors.ts`
- Изменить: `src/browser/actions.ts` (функция `itemFrom` около строки 333,
  `collectPosts` около строки 298, тип `FeedItem` около строки 184)

**Интерфейсы:**
- Использует: `buildCard`, `PostCard`, `RawCard` из задачи 2.
- Отдаёт: `FeedItem` становится алиасом `PostCard`; `read_feed`,
  `read_profile`, `read_replies` начинают отдавать новые поля.

Тестами не покрывается — зависит от живой вёрстки, как и все браузерные
действия проекта. Проверяется вручную в задаче 8.

- [ ] **Шаг 1: Добавить зацепки в selectors.ts**

Дописать в конец `src/browser/selectors.ts`:

```ts
/** Страница поиска. `recent` — вкладка свежего, без неё Threads отдаёт топ. */
export const SEARCH_URL = (query: string, sort: "top" | "recent"): string => {
  const url = new URL("/search", URLS.home);
  url.searchParams.set("q", query);
  url.searchParams.set("serp_type", "default");
  if (sort === "recent") url.searchParams.set("filter", "recent");
  return url.toString();
};

/** Время публикации: Threads рисует его тегом <time> с машинным datetime. */
export const POST_TIME = "time[datetime]";

/**
 * Медиа поста.
 *
 * Аватар автора в разметке — такая же картинка, поэтому опознать медиа можно
 * только исключением: аватар лежит внутри ссылки на профиль (без `/post/` в
 * href) и подписан как фото профиля. Эвристика проверяется на живой странице;
 * если она не работает, честный ответ — null, а не «медиа нет».
 */
export const POST_MEDIA = {
  image: 'img:not([alt*="profile pic" i]):not([alt*="фото профиля" i])',
  video: "video",
  avatarLink: 'a[href^="/@"]:not([href*="/post/"])',
} as const;
```

- [ ] **Шаг 2: Переключить FeedItem на PostCard**

В `src/browser/actions.ts` заменить объявление типа:

```ts
export type FeedItem = {
  author: string | null;
  url: string | null;
  text: string;
};
```

на:

```ts
// Историческое имя оставлено, чтобы не трогать сигнатуры действий: форма
// карточки одна и та же и в ленте, и в поиске, и в ответах.
export type FeedItem = PostCard;
```

и добавить импорты в шапку файла:

```ts
import { buildCard, type PostCard } from "./cards.js";
import { POST_MEDIA, POST_TIME, SEARCH_URL } from "./selectors.js";
```

Удалить из `actions.ts` функцию `authorFromUrl` (она переехала в `cards.ts`).

- [ ] **Шаг 3: Научить itemFrom снимать новые поля**

Заменить `itemFrom` целиком на:

```ts
/** Достаёт из контейнера то, что нам нужно от поста; null — если контейнер пустой. */
async function itemFrom(container: Locator): Promise<FeedItem | null> {
  const href = await container.locator(POST_PERMALINK).first().getAttribute("href").catch(() => null);
  const text = (await container.innerText().catch(() => "")).trim();
  if (!text) return null;

  const datetime = await container.locator(POST_TIME).first().getAttribute("datetime").catch(() => null);

  return buildCard({
    href,
    text,
    datetime,
    likeLabel: await labelOf(container, [...BUTTON_LABELS.like, ...BUTTON_LABELS.unlike]),
    replyLabel: await labelOf(container, [/^ответ/i, /^reply/i, /^comment/i]),
    repostLabel: await labelOf(container, BUTTON_LABELS.repost),
    media: await mediaOf(container),
  });
}

/**
 * Подпись первой подходящей кнопки внутри карточки; null — если такой кнопки нет.
 *
 * Доступное имя не обязано лежать в aria-label: Threads рисует счётчик и
 * текстом внутри кнопки. Поэтому сначала атрибут, а если его нет — содержимое.
 */
async function labelOf(container: Locator, labels: readonly RegExp[]): Promise<string | null> {
  const button = buttonByLabels(container, labels).first();
  if ((await button.count().catch(() => 0)) === 0) return null;

  const aria = await button.getAttribute("aria-label").catch(() => null);
  if (aria?.trim()) return aria;

  const text = await button.innerText().catch(() => "");
  return text.trim() || null;
}

/**
 * Считает медиа внутри карточки, вычитая аватар автора.
 *
 * Отрицательный остаток означает, что эвристика не сошлась с вёрсткой: тогда
 * отдаём null. Записать «медиа нет» в этом случае было бы худшим исходом —
 * ошибка уехала бы в датасет молча.
 */
async function mediaOf(container: Locator): Promise<{ images: number; videos: number } | null> {
  try {
    const images = await container.locator(POST_MEDIA.image).count();
    const videos = await container.locator(POST_MEDIA.video).count();
    const avatars = await container.locator(`${POST_MEDIA.avatarLink} ${POST_MEDIA.image}`).count();

    const own = images - avatars;
    if (own < 0) return null;
    return { images: own, videos };
  } catch {
    return null;
  }
}
```

- [ ] **Шаг 4: Защитить датасет от сломанной вёрстки**

В `collectPosts`, сразу перед `return [...seen.values()];`, вставить:

```ts
  const items = [...seen.values()];

  // Пост без лайков честно даёт ноль, но чтобы у сотни постов подряд не нашлось
  // ни одного счётчика, Threads должен переехать. Отдать в датасет страницу
  // сплошных null — значит спрятать поломку до момента, когда по данным уже
  // посчитают статистику. Порог в пять карточек оставлен на случай, когда
  // выдача действительно крошечная.
  if (items.length >= 5 && items.every((item) => item.likes === null && item.replies === null)) {
    return selectorMiss(page, label, "Ни у одного поста не нашлось счётчиков — вероятно, Threads изменил вёрстку");
  }

  return items;
```

(строка `return [...seen.values()];` при этом удаляется)

- [ ] **Шаг 5: Проверить типы и тесты**

Запустить: `npm run typecheck && npm test`
Ожидание: типы чистые; все существующие тесты проходят.

Если `test/registry.test.ts` падает на моке `readFeed` — это ожидаемо и
чинится в шаге 6.

- [ ] **Шаг 6: Обновить мок в тесте реестра**

В `test/registry.test.ts` заменить строку мока `readFeed`:

```ts
  readFeed: vi.fn(async () => [{ author: "someone", url: null, text: "пост" }]),
```

на:

```ts
  readFeed: vi.fn(async () => [
    {
      author: "someone",
      url: null,
      text: "пост",
      publishedAt: null,
      likes: 0,
      replies: 0,
      reposts: 0,
      media: "none",
      mediaCount: 0,
    },
  ]),
```

- [ ] **Шаг 7: Прогнать всё и закоммитить**

```bash
npm run typecheck && npm test
git add src/browser/selectors.ts src/browser/actions.ts test/registry.test.ts
git commit -m "Карточка поста отдаёт время, счётчики и медиа"
```

---

### Задача 4: Действие `search_posts`

**Файлы:**
- Изменить: `src/browser/actions.ts`
- Изменить: `src/config.ts` (блок `limits`, около строки 55)
- Изменить: `src/actions/registry.ts` (после `read_profile`, около строки 277)
- Изменить: `.env.example`
- Изменить: `test/registry.test.ts`

**Интерфейсы:**
- Использует: `collectPosts`, `open`, `SEARCH_URL`, `FeedItem` из задачи 3.
- Отдаёт: `browser.searchPosts(query: string, limit: number, sort: "top" | "recent"): Promise<{ query: string; sort: string; posts: FeedItem[] }>`
  и действие `search_posts` в реестре — доступное и по REST, и по MCP.

- [ ] **Шаг 1: Написать падающий тест**

Дописать в `test/registry.test.ts` в блок `describe("маршрутизация действий", …)`:

```ts
  it("поиск уходит в браузер и несёт запрос с сортировкой", async () => {
    await execute("search_posts", { query: "today", limit: 50, sort: "recent" });

    expect(browser.searchPosts).toHaveBeenCalledWith("today", 50, "recent");
  });

  it("по умолчанию ищет свежее, а не топ", async () => {
    await execute("search_posts", { query: "today" });

    expect(browser.searchPosts).toHaveBeenCalledWith("today", 100, "recent");
  });

  it("пустой запрос отвергает", async () => {
    await expect(execute("search_posts", { query: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
```

И добавить `searchPosts` в мок браузера в шапке файла:

```ts
  searchPosts: vi.fn(async () => ({ query: "today", sort: "recent", posts: [] })),
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Запустить: `npx vitest run test/registry.test.ts`
Ожидание: FAIL — `execute` не знает действия `search_posts`.

- [ ] **Шаг 3: Реализовать браузерную часть**

Дописать в `src/browser/actions.ts` после `readProfile`:

```ts
/**
 * Ищет посты по запросу и собирает выдачу скроллом.
 *
 * Возобновить скролл между вызовами нельзя: выдача живёт в странице, и каждый
 * новый вызов начинает сверху. Поэтому глубина одного вызова ограничена, а
 * объём набирается количеством разных запросов — так устроен сборщик.
 */
export async function searchPosts(
  query: string,
  limit = 100,
  sort: "top" | "recent" = "recent",
): Promise<{ query: string; sort: "top" | "recent"; posts: FeedItem[] }> {
  return session.withPage(async (page) => {
    await open(page, SEARCH_URL(query, sort));
    const posts = await collectPosts(page, limit, "search");
    return { query, sort, posts };
  });
}
```

- [ ] **Шаг 4: Добавить лимит в конфиг**

В `src/config.ts` в блок `limits` дописать последней строкой:

```ts
    /** Поиск агрессивнее лайков: одна выдача — это десятки экранов скролла. */
    searchesPerDay: num("LIMIT_SEARCHES_PER_DAY", 30),
```

В `.env.example` рядом с прочими лимитами дописать:

```
# Сколько поисковых запросов в сутки разрешено браузеру. Один прогон сборщика — 10-15.
LIMIT_SEARCHES_PER_DAY=30
```

- [ ] **Шаг 5: Добавить действие в реестр**

В `src/actions/registry.ts` после действия `read_profile` вставить:

```ts
  search_posts: define({
    name: "search_posts",
    description:
      "Найти посты по запросу и вернуть карточки выдачи: автор, текст, ссылка, время, счётчики и медиа. " +
      "Сортировка recent отдаёт свежее, top — популярное. Выполняется через браузер.",
    driver: "browser",
    input: z.object({
      query: z.string().trim().min(1).max(100),
      limit: z.number().int().min(1).max(300).default(100),
      sort: z.enum(["top", "recent"]).default("recent"),
    }),
    dailyLimit: () => config.limits.searchesPerDay,
    run: (input) => browser.searchPosts(input.query, input.limit, input.sort),
  }),
```

- [ ] **Шаг 6: Убедиться, что тесты проходят**

Запустить: `npm run typecheck && npm test`
Ожидание: PASS, включая три новых теста.

- [ ] **Шаг 7: Коммит**

```bash
git add src/browser/actions.ts src/config.ts src/actions/registry.ts .env.example test/registry.test.ts
git commit -m "Действие search_posts: поиск постов через браузер"
```

---

### Задача 5: База сборщика

**Файлы:**
- Создать: `src/collect/db.ts`
- Создать: `src/collect/db.test.ts`

**Интерфейсы:**
- Использует: `MediaKind` из задачи 1.
- Отдаёт: `openCollectDb(path: string): CollectDb` и тип `CollectedPost`.
  `CollectDb` — объект с методами `syncQueries`, `nextQueries`, `insertPosts`,
  `recordRun`, `totalPosts`, `allPosts`, `close`.

Отдельный файл БД, не `var/state.db`: там токен и журнал сервиса, и датасету
там не место. `better-sqlite3` работает синхронно — async в этом модуле не
нужен нигде.

- [ ] **Шаг 1: Написать падающий тест**

Создать `src/collect/db.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openCollectDb, type CollectDb, type CollectedPost } from "./db.js";

function post(url: string, extra: Partial<CollectedPost> = {}): CollectedPost {
  return {
    url,
    author: "someone",
    text: "текст поста",
    publishedAt: "2026-08-18T10:00:00.000Z",
    likes: 5,
    replies: 1,
    reposts: 0,
    media: "none",
    mediaCount: 0,
    source: "search",
    foundBy: "today",
    ...extra,
  };
}

let db: CollectDb;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "collect-test-"));
  db = openCollectDb(join(dir, "collect.sqlite"));
});

describe("посты", () => {
  it("записывает и считает", () => {
    expect(db.insertPosts([post("https://t/1"), post("https://t/2")], 1000)).toBe(2);
    expect(db.totalPosts()).toBe(2);
  });

  // Один пост находится по нескольким словам — дедуп по ссылке обязателен,
  // иначе цель «1000 новых за прогон» будет считаться по повторам.
  it("повтор не создаёт дубля и не считается новым", () => {
    db.insertPosts([post("https://t/1")], 1000);

    expect(db.insertPosts([post("https://t/1", { foundBy: "just" })], 2000)).toBe(0);
    expect(db.totalPosts()).toBe(1);
  });

  it("за первым источником оставляет первенство", () => {
    db.insertPosts([post("https://t/1", { source: "search", foundBy: "today" })], 1000);
    db.insertPosts([post("https://t/1", { source: "feed", foundBy: null })], 2000);

    const stored = db.allPosts()[0]!;
    expect(stored.source).toBe("search");
    expect(stored.foundBy).toBe("today");
  });

  it("сохраняет медиа и счётчики как есть, включая null", () => {
    db.insertPosts([post("https://t/1", { media: null, mediaCount: null, likes: null })], 1000);

    const stored = db.allPosts()[0]!;
    expect(stored.media).toBeNull();
    expect(stored.mediaCount).toBeNull();
    expect(stored.likes).toBeNull();
  });
});

describe("ротация слов", () => {
  it("добавляет новые слова и не теряет старые", () => {
    db.syncQueries(["today", "just"]);
    db.syncQueries(["today", "people"]);

    expect(db.nextQueries(10).sort()).toEqual(["just", "people", "today"]);
  });

  it("сначала отдаёт ни разу не искавшиеся", () => {
    db.syncQueries(["today", "just"]);
    db.recordRun("today", { newPosts: 40 }, 1000);

    expect(db.nextQueries(2)).toEqual(["just", "today"]);
  });

  it("среди искавшихся первым отдаёт самое давнее", () => {
    db.syncQueries(["a", "b"]);
    db.recordRun("a", { newPosts: 1 }, 2000);
    db.recordRun("b", { newPosts: 1 }, 1000);

    expect(db.nextQueries(2)).toEqual(["b", "a"]);
  });

  it("отдаёт не больше, чем просили", () => {
    db.syncQueries(["a", "b", "c"]);

    expect(db.nextQueries(2)).toHaveLength(2);
  });

  it("помнит ошибку последнего захода", () => {
    db.syncQueries(["a"]);
    db.recordRun("a", { error: "UPSTREAM" }, 1000);
    db.recordRun("a", { newPosts: 3 }, 2000);

    // Успех должен стирать прошлую ошибку: иначе она будет висеть вечно.
    expect(db.lastError("a")).toBeNull();
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Запустить: `npx vitest run src/collect/db.test.ts`
Ожидание: FAIL — `Failed to resolve import "./db.js"`.

- [ ] **Шаг 3: Реализовать**

Создать `src/collect/db.ts`:

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MediaKind } from "../browser/cards.js";

export type CollectedPost = {
  url: string;
  author: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  media: MediaKind | null;
  mediaCount: number | null;
  source: "search" | "feed";
  foundBy: string | null;
};

export type CollectDb = {
  syncQueries(words: string[]): void;
  nextQueries(count: number): string[];
  insertPosts(posts: CollectedPost[], at: number): number;
  recordRun(word: string, result: { newPosts?: number; error?: string }, at: number): void;
  lastError(word: string): string | null;
  totalPosts(): number;
  allPosts(): CollectedPost[];
  close(): void;
};

/**
 * База сборщика — отдельный файл, не сервисный state.db.
 *
 * Там живут токен и журнал действий, и датасету рядом с ними делать нечего:
 * отдельный файл копируется, архивируется и удаляется целиком, не задевая
 * работу сервиса.
 */
export function openCollectDb(path: string): CollectDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS post (
      url          TEXT PRIMARY KEY,
      author       TEXT,
      text         TEXT NOT NULL,
      published_at TEXT,
      likes        INTEGER,
      replies      INTEGER,
      reposts      INTEGER,
      media        TEXT,
      media_count  INTEGER,
      source       TEXT NOT NULL,
      found_by     TEXT,
      collected_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query (
      text        TEXT PRIMARY KEY,
      last_run_at INTEGER,
      runs        INTEGER NOT NULL DEFAULT 0,
      last_new    INTEGER,
      last_error  TEXT
    );
  `);

  const insertPost = db.prepare(`
    INSERT OR IGNORE INTO post
      (url, author, text, published_at, likes, replies, reposts, media, media_count, source, found_by, collected_at)
    VALUES
      (@url, @author, @text, @publishedAt, @likes, @replies, @reposts, @media, @mediaCount, @source, @foundBy, @collectedAt)
  `);

  const insertMany = db.transaction((posts: CollectedPost[], at: number) => {
    let added = 0;
    for (const post of posts) {
      added += insertPost.run({ ...post, collectedAt: at }).changes;
    }
    return added;
  });

  return {
    syncQueries(words) {
      const insert = db.prepare(`INSERT OR IGNORE INTO query (text) VALUES (?)`);
      db.transaction(() => {
        for (const word of words) insert.run(word);
      })();
    },

    // Слова, которых давно не касались, идут первыми: повторный заход по
    // свежеискавшемуся слову принесёт ту же выдачу, и дедуп её выбросит.
    nextQueries(count) {
      const rows = db
        .prepare(
          `SELECT text FROM query
           ORDER BY last_run_at IS NOT NULL, last_run_at ASC, text ASC
           LIMIT ?`,
        )
        .all(count) as Array<{ text: string }>;
      return rows.map((row) => row.text);
    },

    insertPosts(posts, at) {
      if (posts.length === 0) return 0;
      return insertMany(posts, at);
    },

    recordRun(word, result, at) {
      db.prepare(
        `UPDATE query
            SET last_run_at = ?, runs = runs + 1, last_new = ?, last_error = ?
          WHERE text = ?`,
      ).run(at, result.newPosts ?? null, result.error ?? null, word);
    },

    lastError(word) {
      const row = db.prepare(`SELECT last_error FROM query WHERE text = ?`).get(word) as
        | { last_error: string | null }
        | undefined;
      return row?.last_error ?? null;
    },

    totalPosts() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM post`).get() as { n: number };
      return row.n;
    },

    allPosts() {
      const rows = db.prepare(`SELECT * FROM post ORDER BY collected_at, url`).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        url: row.url as string,
        author: row.author as string | null,
        text: row.text as string,
        publishedAt: row.published_at as string | null,
        likes: row.likes as number | null,
        replies: row.replies as number | null,
        reposts: row.reposts as number | null,
        media: row.media as MediaKind | null,
        mediaCount: row.media_count as number | null,
        source: row.source as "search" | "feed",
        foundBy: row.found_by as string | null,
      }));
    },

    close() {
      db.close();
    },
  };
}
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Запустить: `npx vitest run src/collect/db.test.ts`
Ожидание: PASS, 9 тестов.

- [ ] **Шаг 5: Проверить типы и закоммитить**

```bash
npm run typecheck
git add src/collect/db.ts src/collect/db.test.ts
git commit -m "База сборщика: посты с дедупом и ротация слов"
```

---

### Задача 6: Экспорт в CSV

**Файлы:**
- Создать: `src/collect/csv.ts`
- Создать: `src/collect/csv.test.ts`

**Интерфейсы:**
- Использует: `CollectedPost` из задачи 5.
- Отдаёт: `toCsv(posts: CollectedPost[]): string`.

Тексты постов содержат переводы строк, запятые и кавычки — то есть ровно всё,
на чём ломается наивная склейка через запятую. Поэтому экранирование
покрывается тестом отдельно.

- [ ] **Шаг 1: Написать падающий тест**

Создать `src/collect/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.js";
import type { CollectedPost } from "./db.js";

const base: CollectedPost = {
  url: "https://t/1",
  author: "someone",
  text: "привет",
  publishedAt: "2026-08-18T10:00:00.000Z",
  likes: 5,
  replies: 1,
  reposts: 0,
  media: "image",
  mediaCount: 2,
  source: "search",
  foundBy: "today",
};

describe("toCsv", () => {
  it("ставит заголовок первой строкой", () => {
    expect(toCsv([]).trim()).toBe(
      "url,author,published_at,likes,replies,reposts,media,media_count,source,found_by,text",
    );
  });

  it("пишет пост одной строкой", () => {
    const lines = toCsv([base]).trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '"https://t/1","someone","2026-08-18T10:00:00.000Z",5,1,0,"image",2,"search","today","привет"',
    );
  });

  // Перевод строки внутри поля — законный CSV, если поле в кавычках. Без этого
  // один многострочный пост сдвинул бы весь файл.
  it("экранирует кавычки и переводы строк", () => {
    const csv = toCsv([{ ...base, text: 'он сказал "да"\nи ушёл' }]);

    expect(csv).toContain('"он сказал ""да""\nи ушёл"');
  });

  it("пустые значения оставляет пустыми, а не строкой null", () => {
    const csv = toCsv([{ ...base, author: null, likes: null, media: null, mediaCount: null, foundBy: null }]);
    const row = csv.trim().split("\n")[1]!;

    expect(row).toBe('"https://t/1",,"2026-08-18T10:00:00.000Z",,1,0,,,"search",,"привет"');
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает**

Запустить: `npx vitest run src/collect/csv.test.ts`
Ожидание: FAIL — `Failed to resolve import "./csv.js"`.

- [ ] **Шаг 3: Реализовать**

Создать `src/collect/csv.ts`:

```ts
import type { CollectedPost } from "./db.js";

const HEADER = [
  "url",
  "author",
  "published_at",
  "likes",
  "replies",
  "reposts",
  "media",
  "media_count",
  "source",
  "found_by",
  "text",
];

/** Строки — всегда в кавычках, числа — как есть, пустое — пустым полем. */
function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Собирает датасет в CSV.
 *
 * Текст поста идёт последним столбцом намеренно: он самый длинный и содержит
 * переводы строк, поэтому файл читается глазами куда легче, когда всё
 * табличное стоит слева от него.
 */
export function toCsv(posts: CollectedPost[]): string {
  const rows = posts.map((post) =>
    [
      cell(post.url),
      cell(post.author),
      cell(post.publishedAt),
      cell(post.likes),
      cell(post.replies),
      cell(post.reposts),
      cell(post.media),
      cell(post.mediaCount),
      cell(post.source),
      cell(post.foundBy),
      cell(post.text),
    ].join(","),
  );

  return [HEADER.join(","), ...rows].join("\n") + "\n";
}
```

- [ ] **Шаг 4: Убедиться, что тесты проходят**

Запустить: `npx vitest run src/collect/csv.test.ts`
Ожидание: PASS, 4 теста.

- [ ] **Шаг 5: Проверить типы и закоммитить**

```bash
npm run typecheck
git add src/collect/csv.ts src/collect/csv.test.ts
git commit -m "Экспорт датасета в CSV"
```

---

### Задача 7: Скрипт-сборщик

**Файлы:**
- Создать: `src/collect/queries-en.txt`
**Важно:** каталог `data/` целиком перечислен в `.gitignore`, поэтому список слов
лежит в `src/collect/queries-en.txt` — рядом с кодом, который его читает.

- Создать: `src/collect/runner.ts`
- Создать: `src/collect/runner.test.ts`
- Создать: `scripts/collect.ts`
- Изменить: `package.json` (блок `scripts`)

**Интерфейсы:**
- Использует: `openCollectDb`, `CollectedPost`, `CollectDb` из задачи 5;
  `toCsv` из задачи 6.
- Отдаёт: `runCollection(deps, options): Promise<CollectionReport>` — чистая
  от ввода-вывода логика прогона, и CLI-обёртку `scripts/collect.ts`.

Логика прогона отделена от CLI ровно затем, чтобы её можно было протестировать
с поддельным клиентом сервиса — без браузера, без сети и без живого Threads.

- [ ] **Шаг 1: Составить список слов**

Создать `src/collect/queries-en.txt` — по слову на строку, 80 штук. Слова должны быть
частотными и нейтральными: они работают решетом, а не темой.

```
i
me
my
just
today
tonight
tomorrow
yesterday
now
time
day
week
year
people
person
someone
everyone
friend
family
work
job
money
home
house
city
world
life
love
hate
like
want
need
think
know
feel
say
tell
ask
make
take
give
get
go
come
see
look
watch
read
write
talk
happy
sad
tired
good
bad
best
worst
new
old
first
last
next
really
actually
maybe
always
never
still
about
because
why
how
what
who
where
when
this
that
here
there
please
thanks
```

- [ ] **Шаг 2: Написать падающий тест**

Создать `src/collect/runner.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openCollectDb, type CollectDb, type CollectedPost } from "./db.js";
import { runCollection, type ThreadsClient } from "./runner.js";

function card(url: string) {
  return {
    author: "someone",
    url,
    text: "текст",
    publishedAt: null,
    likes: 1,
    replies: 0,
    reposts: 0,
    media: "none" as const,
    mediaCount: 0,
  };
}

let db: CollectDb;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  db = openCollectDb(join(dir, "collect.sqlite"));
  db.syncQueries(["a", "b", "c"]);
});

/** Клиент, отдающий по n уникальных карточек на каждый вызов. */
function fakeClient(perCall: number): ThreadsClient {
  let issued = 0;
  const next = () => card(`https://t/${(issued += 1)}`);
  return {
    readFeed: vi.fn(async () => Array.from({ length: perCall }, next)),
    searchPosts: vi.fn(async (query: string) => ({
      query,
      posts: Array.from({ length: perCall }, next),
    })),
  };
}

describe("runCollection", () => {
  it("начинает с ленты, потом идёт по словам", async () => {
    const client = fakeClient(2);

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 6, limit: 2 });

    expect(client.readFeed).toHaveBeenCalledTimes(1);
    expect(report.newPosts).toBe(6);
  });

  it("останавливается, набрав цель", async () => {
    const client = fakeClient(10);

    await runCollection({ db, client, sleep: async () => {} }, { target: 10, limit: 10 });

    // Лента уже принесла десять — за слова браться незачем.
    expect(client.searchPosts).not.toHaveBeenCalled();
  });

  it("помечает источник каждого поста", async () => {
    const client = fakeClient(1);

    await runCollection({ db, client, sleep: async () => {} }, { target: 2, limit: 1 });

    const sources = db.allPosts().map((post: CollectedPost) => post.source);
    expect(sources).toContain("feed");
    expect(sources).toContain("search");
  });

  // Разлогин лечится только руками через noVNC — идти дальше бессмысленно.
  it("на NEEDS_LOGIN останавливается сразу", async () => {
    const client = fakeClient(1);
    client.searchPosts = vi.fn(async () => {
      throw Object.assign(new Error("нет сессии"), { code: "NEEDS_LOGIN" });
    });

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 100, limit: 1 });

    expect(report.stoppedBy).toBe("NEEDS_LOGIN");
    expect(client.searchPosts).toHaveBeenCalledTimes(1);
  });

  // А разовая ошибка на одном слове — не повод бросать прогон.
  it("прочую ошибку записывает и идёт дальше", async () => {
    const client = fakeClient(1);
    let call = 0;
    client.searchPosts = vi.fn(async (query: string) => {
      call += 1;
      if (call === 1) throw Object.assign(new Error("сломалось"), { code: "INTERNAL" });
      return { query, posts: [card(`https://t/ok-${call}`)] };
    });

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 2, limit: 1 });

    expect(report.errors).toBe(1);
    expect(client.searchPosts).toHaveBeenCalledTimes(2);
  });

  it("кончились слова — прогон завершается", async () => {
    const client = fakeClient(1);

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 1 });

    expect(report.stoppedBy).toBe("queries_exhausted");
    expect(client.searchPosts).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

Запустить: `npx vitest run src/collect/runner.test.ts`
Ожидание: FAIL — `Failed to resolve import "./runner.js"`.

- [ ] **Шаг 4: Реализовать прогон**

Создать `src/collect/runner.ts`:

```ts
import type { CollectDb, CollectedPost } from "./db.js";

/** То, что прогону нужно от сервиса. Ровно два действия — больше он не зовёт. */
export type ThreadsClient = {
  readFeed(limit: number): Promise<PostCardDto[]>;
  searchPosts(query: string, limit: number): Promise<{ query: string; posts: PostCardDto[] }>;
};

export type PostCardDto = {
  author: string | null;
  url: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  media: CollectedPost["media"];
  mediaCount: number | null;
};

export type CollectionReport = {
  newPosts: number;
  queriesUsed: number;
  errors: number;
  stoppedBy: "target_reached" | "queries_exhausted" | "NEEDS_LOGIN" | "SELECTOR_MISS";
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

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL";

/** Пост без ссылки в датасет не годится: дедуп опирается на неё как на ключ. */
function toStored(card: PostCardDto, source: "search" | "feed", foundBy: string | null): CollectedPost | null {
  if (!card.url) return null;
  return { ...card, url: card.url, source, foundBy };
}

export async function runCollection(deps: Deps, options: Options): Promise<CollectionReport> {
  const { db, client, sleep } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? (() => undefined);

  let newPosts = 0;
  let errors = 0;
  let queriesUsed = 0;

  // Лента идёт первой и ровно одним заходом. Она персонализирована, и при
  // большом объёме заполнила бы датасет десятком одних и тех же авторов.
  try {
    const feed = await client.readFeed(options.limit);
    const stored = feed.map((card) => toStored(card, "feed", null)).filter((post): post is CollectedPost => post !== null);
    newPosts += db.insertPosts(stored, now());
    log(`лента: +${newPosts}`);
  } catch (error) {
    const code = codeOf(error);
    if (FATAL.has(code)) return { newPosts, queriesUsed, errors, stoppedBy: code as "NEEDS_LOGIN" };
    errors += 1;
    log(`лента: ошибка ${code}`);
  }

  if (newPosts >= options.target) {
    return { newPosts, queriesUsed, errors, stoppedBy: "target_reached" };
  }

  // Берём все слова разом в порядке ротации: внутри прогона порядок меняться не
  // должен, иначе одно и то же слово может попасться дважды.
  const words = db.nextQueries(1_000);

  for (const word of words) {
    try {
      const found = await client.searchPosts(word, options.limit);
      const stored = found.posts
        .map((card) => toStored(card, "search", word))
        .filter((post): post is CollectedPost => post !== null);

      const added = db.insertPosts(stored, now());
      newPosts += added;
      queriesUsed += 1;
      db.recordRun(word, { newPosts: added }, now());
      log(`${word}: +${added} (всего ${newPosts})`);
    } catch (error) {
      const code = codeOf(error);
      if (FATAL.has(code)) {
        return { newPosts, queriesUsed, errors, stoppedBy: code as "NEEDS_LOGIN" | "SELECTOR_MISS" };
      }
      errors += 1;
      queriesUsed += 1;
      db.recordRun(word, { error: code }, now());
      log(`${word}: ошибка ${code}`);
    }

    if (newPosts >= options.target) {
      return { newPosts, queriesUsed, errors, stoppedBy: "target_reached" };
    }

    // Пауза между запросами, а не после последнего: ждать перед выходом незачем.
    await sleep(5_000 + Math.floor(Math.random() * 10_000));
  }

  return { newPosts, queriesUsed, errors, stoppedBy: "queries_exhausted" };
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

Запустить: `npx vitest run src/collect/runner.test.ts`
Ожидание: PASS, 6 тестов.

- [ ] **Шаг 6: Написать CLI-обёртку**

Создать `scripts/collect.ts`:

```ts
/**
 * Сборщик датасета: гоняет действия сервиса по списку слов и копит результат.
 *
 * Живёт снаружи сервиса намеренно. Выдача поиска — это скролл в живой странице,
 * возобновить его между запросами нельзя, поэтому объём набирается количеством
 * запросов, а такой цикл — обычный for с паузами. Держать ради него машину
 * состояний внутри сервиса незачем.
 *
 *   npm run collect -- --target 1000
 *   npm run collect -- --export dataset.csv
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toCsv } from "../src/collect/csv.js";
import { openCollectDb } from "../src/collect/db.js";
import { runCollection, type PostCardDto, type ThreadsClient } from "../src/collect/runner.js";

const args = process.argv.slice(2);

function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const dataDir = resolve(process.env.DATA_DIR ?? "./var");
const dbPath = resolve(dataDir, "collect.sqlite");
const db = openCollectDb(dbPath);

const exportTo = option("export");
if (exportTo) {
  const posts = db.allPosts();
  writeFileSync(exportTo, toCsv(posts), "utf8");
  console.log(`Выгружено ${posts.length} постов в ${exportTo}`);
  db.close();
  process.exit(0);
}

const baseUrl = process.env.THREADS_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.API_TOKEN;
if (!token) {
  console.error("Не задан API_TOKEN — сервис не пустит.");
  process.exit(1);
}

/** Ходит в сервис тем же способом, что и любой другой клиент: POST /actions/:name. */
async function call<T>(action: string, input: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/actions/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  const payload = (await response.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };

  if (!payload.ok) {
    throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  }
  return payload.data;
}

const client: ThreadsClient = {
  readFeed: (limit) => call<PostCardDto[]>("read_feed", { limit }),
  searchPosts: (query, limit) => call<{ query: string; posts: PostCardDto[] }>("search_posts", { query, limit }),
};

const wordsFile = resolve(option("queries", "src/collect/queries-en.txt")!);
const words = readFileSync(wordsFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

db.syncQueries(words);

const target = Number(option("target", "1000"));
const limit = Number(option("limit", "100"));

console.log(`Старт: цель ${target} новых постов, ${words.length} слов, база ${dbPath}`);

const report = await runCollection(
  {
    db,
    client,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (message) => console.log(message),
  },
  { target, limit },
);

console.log(
  `Готово: +${report.newPosts} новых, запросов ${report.queriesUsed}, ошибок ${report.errors}, ` +
    `остановка — ${report.stoppedBy}. Всего в базе ${db.totalPosts()}.`,
);

if (report.stoppedBy === "NEEDS_LOGIN") {
  console.error("Сессия Threads истекла — нужен ручной вход через noVNC, см. README.");
}
if (report.stoppedBy === "SELECTOR_MISS") {
  console.error("Threads изменил вёрстку — смотри скриншот в var/failures/ и чини src/browser/selectors.ts.");
}

db.close();
```

- [ ] **Шаг 7: Добавить команду в package.json**

В блок `scripts` файла `package.json` дописать после строки `"auth"`:

```json
    "collect": "tsx scripts/collect.ts",
```

- [ ] **Шаг 8: Прогнать всё и закоммитить**

```bash
npm run typecheck && npm test
git add src/collect/queries-en.txt src/collect/runner.ts src/collect/runner.test.ts scripts/collect.ts package.json
git commit -m "Скрипт-сборщик датасета"
```

---

### Задача 8: Живая проверка и документация

**Файлы:**
- Изменить: `README.md` (раздел «Использование» и «Лимиты»)
- Изменить: `.gitignore`

Первая задача, где нужен работающий сервис с живой сессией Threads. Всё
предыдущее проверялось тестами; здесь проверяется то, что тестами не
проверяется в принципе — совпадение селекторов с настоящей вёрсткой.

- [ ] **Шаг 1: Убедиться, что датасет не попадёт в git**

В `.gitignore` дописать:

```
var/
*.csv
```

(если `var/` там уже есть — добавить только `*.csv`)

- [ ] **Шаг 2: Проверить поиск на живом сервисе**

```bash
curl -s -X POST https://<домен>/actions/search_posts \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"query": "today", "limit": 5}' | jq
```

Ожидание: `ok: true`, пять карточек, у каждой заполнены `url`, `author`,
`text`. Проверить глазами шесть вещей — первые три нашло финальное ревью, и
без них датасет собирать нельзя:

0. **`text` — это текст поста, а не вся карточка.** Сейчас он снимается через
   `innerText` контейнера, а тот включает ник автора, время, подписи кнопок и
   счётчики, а у репоста — ещё и текст цитируемого поста. Если так и есть,
   нужен селектор тела поста в `selectors.ts`: иначе загрязнена будет каждая
   строка датасета, и любая статистика по тексту окажется мусором.
0b. **`media` не помечает аватар как картинку поста.** Ветка «не смогли
   определить» в `mediaOf` недостижима по построению, поэтому при расхождении
   эвристики с вёрсткой поле молча покажет `"none"` или `"image"` у всех
   подряд. Смотреть на посты, про которые точно известно, есть ли в них медиа.
0c. **В `url` нет трекинговых параметров.** Сборщик режет query и hash перед
   записью, но если полезная часть ссылки окажется в параметрах — дедуп
   сломается. Сверить сырой `url` из ответа с тем, что легло в базу.

Дальше — то, что проверялось изначально:

1. `publishedAt` — не `null` (иначе не сошёлся `POST_TIME`);
2. `likes` и `replies` — числа, а не сплошные `null` (иначе не сошлись
   `BUTTON_LABELS`);
3. `media` — есть посты и с `"none"`, и с `"image"`.

- [ ] **Шаг 3: Починить то, что не сошлось**

Если поле пустое у всех карточек — правится только
`src/browser/selectors.ts`, по скриншоту из `var/failures/`.

Отдельно про медиа: если `media` оказалось `"image"` у **каждого** поста,
значит вычитание аватара не сработало и мы считаем аватар за медиа. В этом
случае вернуть `null` из `mediaOf`, пока эвристика не будет исправлена, —
пустое поле честнее неверного. Соврать в датасете хуже, чем недосказать.

- [ ] **Шаг 4: Прогнать сборщик вживую малой целью**

```bash
DATA_DIR=./var npm run collect -- --target 30 --limit 10
```

Ожидание: в логе видны заходы по словам с приростом, в конце — сводка. Прогон
занимает несколько минут.

Заодно замерить время: оценка «~30-50 минут на прогон» в README взята из
головы и живым запуском не подтверждалась. Разбор карточки стоит около десяти
обращений к странице, так что оценка может оказаться заниженной — тогда
поправить README по факту.

- [ ] **Шаг 5: Проверить выгрузку**

```bash
npm run collect -- --export /tmp/check.csv
head -3 /tmp/check.csv
wc -l /tmp/check.csv
```

Ожидание: заголовок на месте, строк примерно на 30 постов, многострочные
тексты не разъехались по столбцам.

- [ ] **Шаг 6: Дописать README**

В раздел «Использование» после примера с `read_replies` добавить:

```markdown
# Поиск постов
curl -X POST https://<домен>/actions/search_posts \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"query": "today", "limit": 100, "sort": "recent"}'
```

И новый раздел перед разделом «Лимиты»:

```markdown
## Сбор датасета

Скрипт `scripts/collect.ts` копит посты в отдельную `var/collect.sqlite`:
один заход в ленту плюс поиск по частотным английским словам из
`src/collect/queries-en.txt`.

```bash
npm run collect -- --target 1000      # один прогон, ~30-50 минут
npm run collect -- --export dataset.csv
```

Прогоны стоит разносить во времени: два подряд за час дадут почти одинаковую
выдачу, и дедуп по ссылке её отбросит. Каждый прогон берёт слова, которых
дольше всех не касался, и ищет свежее — так повторный заход приносит
появившееся после прошлого раза.

Датасет смещён, и это важно при его чтении: поиск отбирает только англоязычные
посты со словом из списка, лента — персональные рекомендации аккаунта. Столбец
`source` позволяет разделить два потока или сравнить их.
```

В разделе «Лимиты» дописать к абзацу про браузерные действия:

```markdown
Поиск ограничен отдельно — 30 запросов в сутки (`LIMIT_SEARCHES_PER_DAY`).
Одного прогона сборщика это не стесняет, но зациклившийся скрипт остановит.
```

- [ ] **Шаг 7: Финальная проверка и коммит**

```bash
npm run typecheck && npm test
git add README.md .gitignore
git commit -m "Документация сбора датасета"
```

---

## Что этот план сознательно не делает

- Не заходит внутрь постов за точными цифрами и комментариями.
- Не считает агрегаты: на выходе сырой датасет, статистику по нему считают
  снаружи.
- Не делает планировщик: прогоны запускаются руками.
- Не определяет язык постов: всё, что нашлось по английским словам, считается
  английским.
