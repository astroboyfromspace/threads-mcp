import type { Locator, Page } from "playwright";
import { ActionError } from "../errors.js";
import { buildCard, countMedia, type PostCard } from "./cards.js";
import {
  BUTTON_LABELS,
  LOGGED_OUT_HINTS,
  POST_CONTAINER,
  POST_MEDIA,
  POST_PERMALINK,
  POST_TEXT_EXCLUDE,
  POST_TEXT_SPAN,
  POST_TIME,
  SEARCH_URL,
  URLS,
} from "./selectors.js";
import { captureFailure, humanDelay, session } from "./session.js";
import { finishProbe, measure, noteCard, noteFail, startProbe, startRound } from "./probe.js";
import { planScroll } from "./scroll.js";

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

/**
 * Состояние, в котором пост или профиль оказывается после действия.
 *
 * Одного `changed` мало: `changed: false` означает и «уже было сделано», и
 * могло бы означать «не удалось понять» — по журналу эти случаи не различить,
 * а разница между ними принципиальная. Поэтому вместе с фактом изменения
 * отдаём итоговое состояние, и «уже стоял лайк» читается однозначно.
 */
export type ToggleState = "liked" | "not_liked" | "reposted" | "not_reposted" | "following" | "not_following";

export type ToggleResult = { changed: boolean; state: ToggleState };

export const TOGGLE_STATE = {
  like: "liked",
  unlike: "not_liked",
  repost: "reposted",
  removeRepost: "not_reposted",
  follow: "following",
  unfollow: "not_following",
} as const satisfies Record<string, ToggleState>;

async function toggleOnPost(
  postUrl: string,
  action: "like" | "unlike" | "repost" | "removeRepost",
): Promise<ToggleResult> {
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
    const state = TOGGLE_STATE[action];

    const buttonLabels = isRepost ? BUTTON_LABELS.repost : BUTTON_LABELS[action];
    const button = await firstVisible(buttonByLabels(scope, buttonLabels), 3_000);

    if (!button) {
      // Для лайка отсутствие кнопки может значить, что дело уже сделано.
      if (!isRepost) {
        const oppositeLabels = action === "like" ? BUTTON_LABELS.unlike : BUTTON_LABELS.like;
        if (await firstVisible(buttonByLabels(scope, oppositeLabels), 3_000)) return { changed: false, state };
      }
      return selectorMiss(page, action, `Не нашёл кнопку «${action}» на странице поста — вероятно, Threads изменил вёрстку`);
    }

    await button.click();
    await page.waitForTimeout(1_200);

    if (!isRepost) {
      await humanDelay();
      return { changed: true, state };
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
      if (alreadyDone) return { changed: false, state };
      return selectorMiss(page, action, `Меню репоста открылось, но нужного пункта в нём нет — вероятно, Threads изменил вёрстку`);
    }

    await confirm.click();
    await page.waitForTimeout(1_000);
    await humanDelay();
    return { changed: true, state };
  });
}

export const likePost = (ref: PostRef) => toggleOnPost(ref.url, "like");
export const unlikePost = (ref: PostRef) => toggleOnPost(ref.url, "unlike");
export const repost = (ref: PostRef) => toggleOnPost(ref.url, "repost");
export const removeRepost = (ref: PostRef) => toggleOnPost(ref.url, "removeRepost");

export async function followUser(username: string): Promise<ToggleResult> {
  return session.withPage(async (page) => {
    await open(page, URLS.profile(username));

    const alreadyFollowing = await firstVisible(buttonByLabels(page, BUTTON_LABELS.unfollow), 3_000);
    if (alreadyFollowing) return { changed: false, state: TOGGLE_STATE.follow };

    const follow = await firstVisible(buttonByLabels(page, BUTTON_LABELS.follow), 5_000);
    if (!follow) {
      return selectorMiss(page, "follow", `Не нашёл кнопку подписки на профиле @${username}`);
    }

    await follow.click();
    await page.waitForTimeout(1_500);
    await humanDelay();
    return { changed: true, state: TOGGLE_STATE.follow };
  });
}

export async function unfollowUser(username: string): Promise<ToggleResult> {
  return session.withPage(async (page) => {
    await open(page, URLS.profile(username));

    const unfollow = await firstVisible(buttonByLabels(page, BUTTON_LABELS.unfollow), 5_000);
    if (!unfollow) {
      const notFollowing = await firstVisible(buttonByLabels(page, BUTTON_LABELS.follow), 3_000);
      if (notFollowing) return { changed: false, state: TOGGLE_STATE.unfollow };
      return selectorMiss(page, "unfollow", `Не нашёл кнопку отписки на профиле @${username}`);
    }

    await unfollow.click();
    await page.waitForTimeout(1_000);

    // Threads просит подтвердить отписку в модальном окне.
    const confirm = await firstVisible(buttonByLabels(page, BUTTON_LABELS.confirmUnfollow), 4_000);
    await confirm?.click().catch(() => undefined);

    await page.waitForTimeout(1_000);
    await humanDelay();
    return { changed: true, state: TOGGLE_STATE.unfollow };
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
    // Пустота для ленты и профиля подозрительна, а для поиска — законный
    // исход: по редкому слову может не найтись ничего. Разрешаем пустой
    // результат только здесь, чтобы такой заход не обрывал прогон сборщика
    // фатальным SELECTOR_MISS.
    const posts = await collectPosts(page, limit, "search", { allowEmpty: true });
    return { query, sort, posts };
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
    const hiddenHref = replies.length < limit ? await hiddenRepliesHref(page) : null;

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

/**
 * Ссылка на страницу скрытых ответов; null — если Threads её не показывает.
 *
 * Ссылка необязательная: под большинством постов скрытых ответов нет вовсе, и
 * это самый обычный исход, а не сбой. Без своего потолка каждый такой — а
 * значит почти каждый — вызов read_replies покорно ждал умолчание Playwright в
 * 30 секунд, чтобы узнать то, что видно сразу.
 */
export async function hiddenRepliesHref(page: Page): Promise<string | null> {
  return page
    .locator('a[href*="hidden_replies"]')
    .first()
    .getAttribute("href", { timeout: CARD_TIMEOUT_MS })
    .catch(() => null);
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

      const href = await hrefOf(container);
      const item = await itemFrom(container, href);
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

type CollectPostsOptions = {
  /**
   * Для ленты и профиля пустая выдача подозрительна и означает сломанный
   * селектор. Для поиска это законный исход: по редкому слову может не
   * найтись ничего, и обрывать прогон сборщика на этом нельзя.
   */
  allowEmpty?: boolean;
};

async function collectPosts(page: Page, limit: number, label: string, options: CollectPostsOptions = {}): Promise<FeedItem[]> {
  const seen = new Map<string, FeedItem>();
  // Контейнеры, уже разобранные хоть раз, — по href пермалинка. Каждый круг
  // скролла заново видит все контейнеры на странице, включая старые; полный
  // разбор карточки стоит около десяти обращений к странице, и без пропуска
  // уже обработанных на сотню постов набегают тысячи лишних round-trip —
  // прогон дольше, а страница держится открытой заметно дольше обычного,
  // что само по себе похоже на автоматизацию. Контейнеры без href (изредка
  // бывают у ответов) разбираем каждый раз заново, как и раньше.
  const parsedHrefs = new Set<string>();
  let idleRounds = 0;

  startProbe(label, limit);

  // Лента бесконечная и подгружается лениво, поэтому скроллим до тех пор, пока
  // появляются новые посты, но не дольше нескольких безрезультатных попыток.
  while (seen.size < limit && idleRounds < 4) {
    const before = seen.size;
    const round = startRound();

    const containers = await page.locator(POST_CONTAINER).all();
    round.containers = containers.length;
    for (const container of containers) {
      if (seen.size >= limit) break;

      const [href, hrefMs] = await measure(() => hrefOf(container));
      round.hrefMs += hrefMs;
      if (href && parsedHrefs.has(href)) {
        round.skipped += 1;
        continue;
      }

      const [item, cardMs] = await measure(() => itemFrom(container, href));
      round.cardMs += cardMs;
      round.parsed += 1;
      noteCard(cardMs);
      if (!item) continue;
      if (href) parsedHrefs.add(href);

      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.set(key, item);
    }

    if (seen.size === before) idleRounds += 1;
    else idleRounds = 0;

    if (seen.size < limit) {
      const [, scrollMs] = await measure(() => scrollDown(page));
      round.scrollMs = scrollMs;
    }
  }

  finishProbe(seen.size);

  if (seen.size === 0) {
    if (options.allowEmpty) return [];
    await assertStillLoggedIn(page);
    return selectorMiss(page, label, "Не нашёл ни одного поста — вероятно, Threads изменил вёрстку");
  }

  const items = [...seen.values()];

  // Пост без лайков честно даёт ноль — это нормально и ожидаемо, и у ленты
  // малоактивного аккаунта или у профиля с редкими реакциями пять таких
  // постов подряд не редкость, а обычное дело. Ложное падение на законной
  // выдаче хуже пропущенного переезда вёрстки: оно ломает работу каждый
  // день, а переезд вёрстки ловится живой проверкой. Поэтому падаем только
  // когда счётчика не нашлось вовсе ни у одной карточки — все три значения
  // именно null у всех подряд, а не когда они честно нулевые.
  if (items.length >= 5 && items.every((item) => item.likes === null && item.replies === null && item.reposts === null)) {
    return selectorMiss(page, label, "Ни у одного поста не нашлось ни одного счётчика — вероятно, Threads изменил вёрстку");
  }

  return items;
}

/**
 * Достаёт из контейнера то, что нам нужно от поста; null — если контейнер
 * пустой: нет ни текста, ни ссылки на пост. Пост без текста (например, видео
 * с темой без подписи) — законный случай, его отбрасывать нельзя; этим же
 * правилом руководствуется buildCard в cards.ts, здесь — только ранний выход,
 * чтобы не делать лишних round-trip за датой и счётчиками для пустых карточек.
 *
 * href принимается уже готовым: вызывающая сторона всё равно достаёт его сама
 * (чтобы решить, разбирать ли контейнер заново), и повторный round-trip за тем
 * же атрибутом был бы лишним.
 */
async function itemFrom(container: Locator, href: string | null): Promise<FeedItem | null> {
  const text = await textOf(container);
  // Карточку не прочитать — пропускаем целиком. Записать её с пустым текстом
  // значило бы протащить в датасет пост-призрак, который на странице есть, а у
  // нас без текста.
  if (text === null) return null;
  if (!text && !href) return null;

  const datetime = await container
    .locator(POST_TIME)
    .first()
    .getAttribute("datetime", { timeout: CARD_TIMEOUT_MS })
    .catch(() => {
      noteFail("time");
      return null;
    });

  return buildCard({
    href,
    text,
    datetime,
    likeLabel: await labelOf(container, [...BUTTON_LABELS.like, ...BUTTON_LABELS.unlike]),
    replyLabel: await labelOf(container, BUTTON_LABELS.reply),
    repostLabel: await labelOf(container, BUTTON_LABELS.repost),
    media: await mediaOf(container),
  });
}

/** Возвращается, когда кнопка найдена, но ни текст, ни aria-label числа не несут — законный ноль, а не «не нашли». */
const FOUND_EMPTY_LABEL = "0";

/**
 * Потолок ожидания при чтении одной карточки.
 *
 * Локаторы карточек привязаны к номеру в списке, а Threads переиспользует
 * контейнеры при виртуальном скролле: пока мы разбираем десятую карточку, она
 * может уехать из DOM. По умолчанию Playwright ждёт такой локатор 30 секунд,
 * и на длинной выдаче это давало запросы по полторы минуты, часть из которых
 * умирала с «locator.evaluate: Timeout 30000ms exceeded» — одна пропавшая
 * карточка роняла сбор целиком.
 *
 * Две секунды — с запасом на живую отрисовку, но без получасовых зависаний:
 * карточка, которой уже нет, отсеивается сразу и разбирается заново на
 * следующем круге скролла, когда список устоится.
 */
export const CARD_TIMEOUT_MS = 2_000;

/**
 * Подпись первой подходящей кнопки внутри карточки.
 *
 * null — кнопка не нашлась вообще; это отличие важно: на нём стоит страж
 * сломанной вёрстки в collectPosts, который должен падать только когда
 * счётчика не нашлось вовсе, а не когда он честно нулевой.
 *
 * Число Threads рисует текстом внутри кнопки, а не в aria-label: атрибут
 * держит неизменный глагол («Like», «Repost») без счётчика, поэтому в
 * приоритете содержимое, атрибут — запасной источник. У поста без лайков
 * текст внутри кнопки пустой — это законный ноль: кнопка найдена, просто
 * подписывать нечем, и возвращать null здесь означало бы путать его с
 * ненайденной кнопкой.
 */
async function labelOf(container: Locator, labels: readonly RegExp[]): Promise<string | null> {
  const button = buttonByLabels(container, labels).first();
  if ((await button.count().catch(() => 0)) === 0) return null;

  const text = await button.innerText({ timeout: CARD_TIMEOUT_MS }).catch(() => {
    noteFail("labelText");
    return "";
  });
  if (text.trim()) return text;

  const aria = await button.getAttribute("aria-label", { timeout: CARD_TIMEOUT_MS }).catch(() => {
    noteFail("labelAria");
    return null;
  });
  if (aria?.trim()) return aria;

  return FOUND_EMPTY_LABEL;
}

/**
 * Снимает с карточки сырые прямоугольники картинок и видео и отдаёт их в
 * countMedia() (cards.ts) — чистую функцию, которую можно проверить тестами
 * без браузера. Здесь, в браузерном слое, только сбор: подпись и геометрия
 * (getBoundingClientRect) недоступны локатором без похода в браузер за
 * каждой картинкой отдельно, поэтому — один evaluate.
 *
 * Картинка-кандидат — та, чей alt не похож на подпись аватара (см.
 * POST_MEDIA.avatarAltPattern). Для каждой такой картинки берём прямоугольник
 * или null, если размер получить не удалось (ширина 0 — так бывает у ещё не
 * отрисованных лениво картинок); дальше решение за countMedia().
 */
async function mediaOf(container: Locator): Promise<{ images: number; videos: number } | null> {
  try {
    const raw = await container.evaluate((el, { image, video, avatarAltPattern }) => {
      const avatarAlt = new RegExp(avatarAltPattern, "i");

      // Проект собирается без lib "dom" (Node-код), поэтому DOM-типы внутри
      // browser-колбэка не видны tsc — приводим через any, код всё равно
      // выполняется в браузере Playwright, а не проверяется здесь по типам.
      const rectOf = (node: any): { width: number; height: number } | null => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 ? { width: rect.width, height: rect.height } : null;
      };

      const imgs = Array.from(el.querySelectorAll(image)) as any[];
      const candidates = imgs.filter((img) => !avatarAlt.test(img.alt || ""));

      const videos = (Array.from(el.querySelectorAll(video)) as any[])
        .map(rectOf)
        .filter((rect): rect is { width: number; height: number } => rect !== null);

      return { images: candidates.map(rectOf), videos };
    }, POST_MEDIA, { timeout: CARD_TIMEOUT_MS });

    return countMedia(raw.images, raw.videos, { minWidth: POST_MEDIA.minWidth, tolerance: POST_MEDIA.sizeTolerance });
  } catch {
    noteFail("media");
    return null;
  }
}

/**
 * Тело поста — самый длинный span[dir="auto"] внутри карточки без предка-
 * ссылки и предка-кнопки, см. POST_TEXT_SPAN и POST_TEXT_EXCLUDE в
 * selectors.ts. Обход — через evaluate: правило про предков нельзя выразить
 * локатором Playwright, а обходить каждый span отдельным round-trip дорого.
 *
 * closest() не годится напрямую: если саму карточку когда-нибудь завернут в
 * ссылку целиком, он найдёт предка-ссылку и снаружи контейнера. Поэтому
 * поднимаемся вручную и останавливаемся на границе контейнера.
 */
async function textOf(container: Locator): Promise<string | null> {
  return container.evaluate((el, { spanSelector, excludeSelector, timeSelector }) => {
    // Тот же повод для any, что и в mediaOf выше: DOM-типы недоступны tsc в
    // Node-конфигурации проекта, а сам код выполняется в браузере.
    const spans = Array.from(el.querySelectorAll(spanSelector)) as any[];
    let longest = "";

    for (const span of spans) {
      // Возраст поста Threads кладёт в такой же span, только с <time> внутри.
      // Обычно он короче текста и проигрывает по длине, но ответ из одного
      // эмодзи ровно так же длиной в два символа — и «5m» побеждал «👍».
      if (span.querySelector(timeSelector) || span.closest(timeSelector)) continue;

      let node: any = span;
      let excluded = false;
      while (node && node !== el) {
        if (node.matches(excludeSelector)) {
          excluded = true;
          break;
        }
        node = node.parentElement;
      }
      if (excluded) continue;

      const value = (span.textContent ?? "").trim();
      if (value.length > longest.length) longest = value;
    }

    return longest;
  }, { spanSelector: POST_TEXT_SPAN, excludeSelector: POST_TEXT_EXCLUDE, timeSelector: POST_TIME }, { timeout: CARD_TIMEOUT_MS })
    // null означает «карточку не прочитать», и это не то же самое, что пустой
    // текст: пост из одного видео законно пуст, а исчезнувшая карточка должна
    // быть пропущена и разобрана заново на следующем круге скролла.
    .catch(() => {
      noteFail("text");
      return null;
    });
}

/**
 * Ссылка на пост из его контейнера; null — если пермалинка нет или карточка
 * уехала из DOM.
 *
 * Потолок здесь обязателен. Без него действует умолчание Playwright в 30
 * секунд, и контейнер, убранный виртуальным скроллом, оплачивается полными
 * тридцатью секундами ожидания. В прогоне 2026-08-21 таких карточек набралось
 * 15 — 424 секунды из 493 ушли ровно сюда, при том что здоровый сбор тратит на
 * все сто карточек полсекунды.
 */
export async function hrefOf(container: Locator): Promise<string | null> {
  return container
    .locator(POST_PERMALINK)
    .first()
    .getAttribute("href", { timeout: CARD_TIMEOUT_MS })
    .catch(() => {
      noteFail("href");
      return null;
    });
}

/** Ключ для отсева повторов: ответ может быть и без пермалинка, тогда опознаём по тексту. */
const keyOf = (item: FeedItem) => item.url ?? item.text.slice(0, 120);

/**
 * Круг прокрутки: серия щелчков колеса, изредка движение курсора, пауза на
 * подгрузку. Форма круга — в planScroll (scroll.ts), здесь только исполнение.
 *
 * Раньше это было одно событие ровно на 2000 пикселей ровно через 1200 мс —
 * со стороны страницы такой ритм не похож ни на мышь, ни на трекпад. Скорость
 * сбора при этом просела втрое, и это осознанный размен: прогон всё равно
 * идёт в фоне по расписанию, а блокировка аккаунта стоит куда дороже
 * потерянных минут.
 */
async function scrollDown(page: Page): Promise<void> {
  const plan = planScroll();

  for (const [index, chunk] of plan.chunks.entries()) {
    await page.mouse.wheel(0, chunk);
    await page.waitForTimeout(plan.chunkPauses[index]!);
  }

  // Курсор двигаем после серии, а не до: у человека это обычно отдельное
  // движение между прокрутками, а не одновременное с ними.
  if (plan.mouse) {
    await page.mouse.move(plan.mouse.x, plan.mouse.y, { steps: 8 }).catch(() => undefined);
  }

  await page.waitForTimeout(plan.pauseMs);
}

/** Пустая выдача бывает и от того, что нас разлогинило, — это другая ошибка, чем сломанный селектор. */
async function assertStillLoggedIn(page: Page): Promise<void> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (LOGGED_OUT_HINTS.some((hint) => hint.test(body.slice(0, 2_000)))) {
    session.markLoggedOut();
    throw new ActionError("NEEDS_LOGIN", "Threads показывает страницу для незалогиненных", { retryable: false });
  }
}

const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Сколько символов после pk ещё считается «рядом» — с запасом на счётчики поста. */
const MEDIA_INFO_WINDOW = 4_000;

/**
 * Разворачивает шорткод из ссылки в pk поста.
 *
 * Это не media ID: pk (~3.9e18) — инстаграмный идентификатор, а Graph API
 * принимает числа вида 17…/18… из другого пространства, и одно из другого не
 * выводится. Здесь pk нужен только как ключ поиска нужного поста на странице.
 */
export function pkFromShortcode(shortcode: string): string | null {
  let value = 0n;
  for (const char of shortcode) {
    const digit = SHORTCODE_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 64n + BigInt(digit);
  }
  return shortcode ? value.toString() : null;
}

/**
 * Достаёт media ID поста из данных его страницы.
 *
 * В JSON страницы у каждого поста рядом с pk лежит text_post_app_info.id —
 * это и есть идентификатор, которым оперирует Graph API. Ищем именно по pk:
 * на странице поста лежат ещё и ответы со своими media ID, и промах здесь
 * означал бы ответ не тому человеку.
 */
export function mediaIdFromPageHtml(html: string, pk: string): string | null {
  const anchor = `"pk":"${pk}"`;
  for (let at = html.indexOf(anchor); at >= 0; at = html.indexOf(anchor, at + anchor.length)) {
    const found = /XDTTextPostAppMediaInfo:(\d+)/.exec(html.slice(at, at + MEDIA_INFO_WINDOW));
    if (found) return found[1]!;
  }
  return null;
}

/**
 * Media ID Threads — 17–18 цифр, шорткод из ссылки — 11 символов base64.
 * Цифровой шорткод теоретически возможен, поэтому за media ID считаем только
 * заведомо более длинные числа.
 */
const MEDIA_ID_DIGITS = /^\d{15,}$/;

/**
 * Узнаёт media ID, если он уже на руках, — в ссылке или вместо шорткода.
 *
 * Ссылку часто собирают руками из media ID, который отдал get_conversation:
 * получается /@denisfromspace/post/17967428262139577. Страницы по такому адресу
 * нет, Threads уводит на профиль, и поиск media ID в её данных ничего не
 * находил — снаружи это выглядело как сломанный селектор.
 */
export function mediaIdFromPostRef(ref: string): string | null {
  const candidate = /\/post\/([^/?#]+)/.exec(ref)?.[1] ?? ref;
  return MEDIA_ID_DIGITS.test(candidate) ? candidate : null;
}

/** Открылась ли именно страница поста: несуществующий адрес Threads уводит на профиль или в ленту. */
export function isPostPage(url: string): boolean {
  return /\/post\/[^/?#]+/.test(url);
}

/**
 * Находит media ID поста по ссылке на него.
 *
 * Официальный API не умеет искать пост по ссылке, а ответить без media ID
 * нельзя, поэтому открываем страницу браузером и читаем ID из её же данных.
 */
export async function resolveMediaId(postUrl: string): Promise<{ url: string; media_id: string }> {
  const shortcode = /\/post\/([^/?#]+)/.exec(postUrl)?.[1];
  if (!shortcode) {
    throw new ActionError("INVALID_INPUT", `В ссылке нет шорткода поста: ${postUrl}`, { retryable: false });
  }

  return resolveMediaIdByShortcode(shortcode, postUrl);
}

/**
 * То же, но когда на руках один шорткод без ссылки.
 *
 * Так выглядит самый частый промах: шорткод виден и в адресе поста, и в выдаче
 * читалок, поэтому его естественно принять за идентификатор поста — а Graph на
 * него отвечает «Param reply_to_id is not a valid threads_media ID». Собрать
 * ссылку самим нельзя: в канонический адрес входит ник автора, которого рядом с
 * шорткодом может и не быть. Зато Threads сам разворачивает короткий адрес
 * /t/<шорткод> в канонический, и дальше всё как с обычной ссылкой.
 */
export async function resolveMediaIdByShortcode(
  shortcode: string,
  postUrl = `${URLS.home}t/${shortcode}`,
): Promise<{ url: string; media_id: string }> {
  const ready = mediaIdFromPostRef(shortcode) ?? mediaIdFromPostRef(postUrl);
  if (ready) return { url: postUrl, media_id: ready };

  const pk = pkFromShortcode(shortcode);
  if (!pk) {
    throw new ActionError("INVALID_INPUT", `«${shortcode}» не похож на шорткод поста Threads`, { retryable: false });
  }

  return session.withPage(async (page) => {
    await open(page, postUrl);

    // Страницы у несуществующего поста нет, и Threads молча уводит на профиль
    // или в ленту. Отличить это от изменившейся вёрстки можно только здесь:
    // дальше и там, и там просто «media ID не найден».
    if (!isPostPage(page.url())) {
      await assertStillLoggedIn(page);
      throw new ActionError(
        "INVALID_INPUT",
        `Threads не открыл пост по этой ссылке, а увёл на ${page.url()} — вероятно, поста нет или он удалён`,
        { retryable: false },
      );
    }

    const mediaId = mediaIdFromPageHtml(await page.content(), pk);
    if (!mediaId) {
      await assertStillLoggedIn(page);
      return selectorMiss(page, "media-id", "Не нашёл media ID в данных страницы поста — вероятно, Threads изменил их формат");
    }

    return { url: page.url(), media_id: mediaId };
  });
}
