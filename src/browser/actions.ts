import type { Locator, Page } from "playwright";
import { ActionError } from "../errors.js";
import { buildCard, type PostCard } from "./cards.js";
import { BUTTON_LABELS, LOGGED_OUT_HINTS, POST_CONTAINER, POST_MEDIA, POST_PERMALINK, POST_TIME, SEARCH_URL, URLS } from "./selectors.js";
import { captureFailure, humanDelay, session } from "./session.js";

/** Ищет элемент нужной роли по любой из подписей (интерфейс может быть на русском или английском). */
function byLabels(scope: Page | Locator, role: "button" | "menuitem", labels: readonly RegExp[]): Locator {
  const candidates = labels.map((label) => scope.getByRole(role, { name: label }));
  return candidates.reduce((acc, next) => acc.or(next));
}

const buttonByLabels = (scope: Page | Locator, labels: readonly RegExp[]) => byLabels(scope, "button", labels);

async function firstVisible(locator: Locator, timeoutMs = 8_000): Promise<Locator | null> {
  try {
    const target = locator.first();
    await target.waitFor({ state: "visible", timeout: timeoutMs });
    return target;
  } catch {
    return null;
  }
}

/** Открывает страницу и убеждается, что нас не выкинуло на форму входа. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);

  if (page.url().includes("/login")) {
    session.markLoggedOut();
    throw new ActionError("NEEDS_LOGIN", "Threads перебросил на форму входа — сессия истекла", { retryable: false });
  }
}

async function selectorMiss(page: Page, label: string, message: string): Promise<never> {
  const screenshot = await captureFailure(page, label);
  throw new ActionError("SELECTOR_MISS", message, {
    retryable: false,
    details: { screenshot, url: page.url() },
  });
}

export type PostRef = { url: string };

/**
 * Сужает поиск до контейнера конкретного поста.
 *
 * Если опознать не удалось — отдаёт первый контейнер на странице: на странице
 * поста это сам пост. Всю страницу возвращаем только когда контейнеров нет
 * вовсе, иначе следующий же шаг молча ушёл бы искать кнопки по ответам.
 */
async function scopeToPost(page: Page, postUrl: string): Promise<Page | Locator> {
  const containers = page.locator(POST_CONTAINER);
  if ((await containers.count()) === 0) return page;

  const shortcode = /\/post\/([^/?#]+)/.exec(postUrl)?.[1];
  if (shortcode) {
    const exact = containers.filter({ has: page.locator(`a[href*="/post/${shortcode}"]`) }).first();
    if ((await exact.count()) > 0) return exact;
  }
  return containers.first();
}

async function toggleOnPost(
  postUrl: string,
  action: "like" | "unlike" | "repost" | "removeRepost",
): Promise<{ changed: boolean }> {
  return session.withPage(async (page) => {
    await open(page, postUrl);

    // Ищем кнопки только внутри нужного поста: на странице лежат ещё и ответы,
    // и родительский пост, если открыт ответ, — у всех такие же кнопки, и поиск
    // по всей странице однажды поставит лайк не туда. Опознаём пост по его же
    // shortcode в ссылке-пермалинке.
    const scope = await scopeToPost(page, postUrl);

    // Лайк и репост устроены по-разному. У лайка состояние видно по самой
    // кнопке: «Like» → «Unlike». У репоста кнопка всегда подписана «Repost», а
    // состояние видно только в её меню: «Repost/Quote», когда репоста нет, и
    // «Remove/Quote», когда он есть.
    const isRepost = action === "repost" || action === "removeRepost";

    const buttonLabels = isRepost ? BUTTON_LABELS.repost : BUTTON_LABELS[action];
    const button = await firstVisible(buttonByLabels(scope, buttonLabels), 3_000);

    if (!button) {
      // Для лайка отсутствие кнопки может значить, что дело уже сделано.
      if (!isRepost) {
        const oppositeLabels = action === "like" ? BUTTON_LABELS.unlike : BUTTON_LABELS.like;
        if (await firstVisible(buttonByLabels(scope, oppositeLabels), 3_000)) return { changed: false };
      }
      return selectorMiss(page, action, `Не нашёл кнопку «${action}» на странице поста — вероятно, Threads изменил вёрстку`);
    }

    await button.click();
    await page.waitForTimeout(1_200);

    if (!isRepost) {
      await humanDelay();
      return { changed: true };
    }

    // Пункт меню — именно menuitem, а не кнопка: среди кнопок поиск нашёл бы ту
    // же кнопку репоста под постом, повторный клик закрыл бы меню, и действие
    // молча не произошло бы при ответе «готово».
    const wanted = action === "repost" ? BUTTON_LABELS.confirmRepost : BUTTON_LABELS.removeRepost;
    const opposite = action === "repost" ? BUTTON_LABELS.removeRepost : BUTTON_LABELS.confirmRepost;

    // Меню рисуется не мгновенно, а «пункта нет» и «пункт ещё не появился»
    // снаружи неразличимы, поэтому ждём его заметно дольше клика. Первый клик
    // по холодной странице к тому же случается раньше, чем Threads навешивает
    // обработчик, и меню не открывается вовсе — поэтому вторая попытка.
    let confirm = await firstVisible(byLabels(page, "menuitem", wanted), 8_000);
    let alreadyDone = confirm ? null : await firstVisible(byLabels(page, "menuitem", opposite), 2_000);

    if (!confirm && !alreadyDone) {
      await button.click();
      await page.waitForTimeout(1_500);
      confirm = await firstVisible(byLabels(page, "menuitem", wanted), 8_000);
      alreadyDone = confirm ? null : await firstVisible(byLabels(page, "menuitem", opposite), 4_000);
    }

    if (!confirm) {
      await page.keyboard.press("Escape").catch(() => undefined);
      if (alreadyDone) return { changed: false };
      return selectorMiss(page, action, `Меню репоста открылось, но нужного пункта в нём нет — вероятно, Threads изменил вёрстку`);
    }

    await confirm.click();
    await page.waitForTimeout(1_000);
    await humanDelay();
    return { changed: true };
  });
}

export const likePost = (ref: PostRef) => toggleOnPost(ref.url, "like");
export const unlikePost = (ref: PostRef) => toggleOnPost(ref.url, "unlike");
export const repost = (ref: PostRef) => toggleOnPost(ref.url, "repost");
export const removeRepost = (ref: PostRef) => toggleOnPost(ref.url, "removeRepost");

export async function followUser(username: string): Promise<{ changed: boolean }> {
  return session.withPage(async (page) => {
    await open(page, URLS.profile(username));

    const alreadyFollowing = await firstVisible(buttonByLabels(page, BUTTON_LABELS.unfollow), 3_000);
    if (alreadyFollowing) return { changed: false };

    const follow = await firstVisible(buttonByLabels(page, BUTTON_LABELS.follow), 5_000);
    if (!follow) {
      return selectorMiss(page, "follow", `Не нашёл кнопку подписки на профиле @${username}`);
    }

    await follow.click();
    await page.waitForTimeout(1_500);
    await humanDelay();
    return { changed: true };
  });
}

export async function unfollowUser(username: string): Promise<{ changed: boolean }> {
  return session.withPage(async (page) => {
    await open(page, URLS.profile(username));

    const unfollow = await firstVisible(buttonByLabels(page, BUTTON_LABELS.unfollow), 5_000);
    if (!unfollow) {
      const notFollowing = await firstVisible(buttonByLabels(page, BUTTON_LABELS.follow), 3_000);
      if (notFollowing) return { changed: false };
      return selectorMiss(page, "unfollow", `Не нашёл кнопку отписки на профиле @${username}`);
    }

    await unfollow.click();
    await page.waitForTimeout(1_000);

    // Threads просит подтвердить отписку в модальном окне.
    const confirm = await firstVisible(buttonByLabels(page, BUTTON_LABELS.confirmUnfollow), 4_000);
    await confirm?.click().catch(() => undefined);

    await page.waitForTimeout(1_000);
    await humanDelay();
    return { changed: true };
  });
}

// Историческое имя оставлено, чтобы не трогать сигнатуры действий: форма
// карточки одна и та же и в ленте, и в поиске, и в ответах.
export type FeedItem = PostCard;

/** Читает ленту, подгружая её скроллом, пока не наберётся нужное число постов. */
export async function readFeed(limit = 20): Promise<FeedItem[]> {
  return session.withPage(async (page) => {
    await open(page, URLS.home);
    return collectPosts(page, limit, "feed");
  });
}

export async function readProfile(username: string, limit = 20): Promise<{ username: string; posts: FeedItem[] }> {
  return session.withPage(async (page) => {
    await open(page, URLS.profile(username));
    const posts = await collectPosts(page, limit, "profile");
    return { username: username.replace(/^@/, ""), posts };
  });
}

export type ReplyItem = FeedItem & { hidden: boolean };

export type ThreadView = {
  url: string;
  post: FeedItem | null;
  replies: ReplyItem[];
};

/**
 * Читает ответы под постом — в том числе под чужим.
 *
 * Официальный API отдаёт беседу только под своими постами, поэтому чужие
 * комментарии доступны единственным способом: открыть страницу поста браузером.
 * Список плоский: ответы на ответы Threads показывает тем же контейнером, и
 * восстановить вложенность по вёрстке нечем.
 */
export async function readReplies(postUrl: string, limit = 20): Promise<ThreadView> {
  return session.withPage(async (page) => {
    await open(page, postUrl);

    const shortcode = /\/post\/([^/?#]+)/.exec(postUrl)?.[1] ?? null;
    const url = page.url();
    const { post, replies } = await collectReplies(page, shortcode, limit, false);

    // Часть ответов Threads прячет как подозрительные и показывает отдельной
    // страницей. Под чужими постами так уходит большинство комментариев: агент,
    // спросивший «что ответили», без них увидел бы пустоту вместо ответов.
    const hiddenHref =
      replies.length < limit
        ? await page.locator('a[href*="hidden_replies"]').first().getAttribute("href").catch(() => null)
        : null;

    if (hiddenHref) {
      await open(page, new URL(hiddenHref, URLS.home).toString());
      const hidden = await collectReplies(page, shortcode, limit - replies.length, true);
      replies.push(...hidden.replies);
    }

    // Пост без комментариев — нормальный ответ, а не ошибка. Ошибка — когда со
    // страницы не удалось прочитать вообще ничего, включая сам пост.
    if (!post && replies.length === 0) {
      await assertStillLoggedIn(page);
      return selectorMiss(page, "replies", "Не нашёл на странице ни поста, ни ответов — вероятно, Threads изменил вёрстку");
    }

    return { url, post, replies };
  });
}

/** Собирает со страницы поста сам пост и ответы под ним, подгружая их скроллом. */
async function collectReplies(
  page: Page,
  shortcode: string | null,
  limit: number,
  hidden: boolean,
): Promise<{ post: FeedItem | null; replies: ReplyItem[] }> {
  const collected = new Map<string, ReplyItem>();
  let post: FeedItem | null = null;
  let idleRounds = 0;

  while (collected.size < limit && idleRounds < 4) {
    const before = collected.size;

    const containers = await page.locator(POST_CONTAINER).all();
    for (const [index, container] of containers.entries()) {
      if (collected.size >= limit) break;

      const item = await itemFrom(container);
      if (!item) continue;

      // Сам пост тоже лежит в контейнере поста и в ответы попасть не должен.
      // Опознаём его по shortcode в ссылке; если пермалинка нет — по положению:
      // первый контейнер на странице поста и есть пост. На странице скрытых
      // ответов поста нет вовсе, поэтому там правило по положению не работает.
      const isPost = shortcode ? Boolean(item.url?.includes(`/post/${shortcode}`)) : !hidden && index === 0;
      if (isPost) {
        post ??= item;
        continue;
      }

      const key = keyOf(item);
      if (collected.has(key)) continue;
      collected.set(key, { ...item, hidden });
    }

    if (collected.size === before) idleRounds += 1;
    else idleRounds = 0;

    if (collected.size < limit) await scrollDown(page);
  }

  return { post, replies: [...collected.values()] };
}

async function collectPosts(page: Page, limit: number, label: string): Promise<FeedItem[]> {
  const seen = new Map<string, FeedItem>();
  let idleRounds = 0;

  // Лента бесконечная и подгружается лениво, поэтому скроллим до тех пор, пока
  // появляются новые посты, но не дольше нескольких безрезультатных попыток.
  while (seen.size < limit && idleRounds < 4) {
    const before = seen.size;

    const containers = await page.locator(POST_CONTAINER).all();
    for (const container of containers) {
      if (seen.size >= limit) break;

      const item = await itemFrom(container);
      if (!item) continue;

      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.set(key, item);
    }

    if (seen.size === before) idleRounds += 1;
    else idleRounds = 0;

    if (seen.size < limit) await scrollDown(page);
  }

  if (seen.size === 0) {
    await assertStillLoggedIn(page);
    return selectorMiss(page, label, "Не нашёл ни одного поста — вероятно, Threads изменил вёрстку");
  }

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
}

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

/** Ключ для отсева повторов: ответ может быть и без пермалинка, тогда опознаём по тексту. */
const keyOf = (item: FeedItem) => item.url ?? item.text.slice(0, 120);

async function scrollDown(page: Page): Promise<void> {
  await page.mouse.wheel(0, 2_000);
  await page.waitForTimeout(1_200);
}

/** Пустая выдача бывает и от того, что нас разлогинило, — это другая ошибка, чем сломанный селектор. */
async function assertStillLoggedIn(page: Page): Promise<void> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (LOGGED_OUT_HINTS.some((hint) => hint.test(body.slice(0, 2_000)))) {
    session.markLoggedOut();
    throw new ActionError("NEEDS_LOGIN", "Threads показывает страницу для незалогиненных", { retryable: false });
  }
}
