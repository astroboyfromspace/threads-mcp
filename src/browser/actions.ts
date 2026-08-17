import type { Locator, Page } from "playwright";
import { ActionError } from "../errors.js";
import { BUTTON_LABELS, LOGGED_OUT_HINTS, POST_CONTAINER, POST_PERMALINK, URLS } from "./selectors.js";
import { captureFailure, humanDelay, session } from "./session.js";

/** Ищет кнопку по любой из подписей (интерфейс может быть на русском или английском). */
function buttonByLabels(scope: Page | Locator, labels: readonly RegExp[]): Locator {
  const candidates = labels.map((label) => scope.getByRole("button", { name: label }));
  return candidates.reduce((acc, next) => acc.or(next));
}

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

async function toggleOnPost(
  postUrl: string,
  action: "like" | "unlike" | "repost" | "removeRepost",
): Promise<{ changed: boolean }> {
  return session.withPage(async (page) => {
    await open(page, postUrl);

    const targetLabels = BUTTON_LABELS[action];
    const oppositeLabels =
      action === "like" ? BUTTON_LABELS.unlike
      : action === "unlike" ? BUTTON_LABELS.like
      : action === "repost" ? BUTTON_LABELS.removeRepost
      : BUTTON_LABELS.repost;

    // Если кнопка уже в нужном состоянии, действие идемпотентно: ничего не делаем.
    const alreadyDone = await firstVisible(buttonByLabels(page, oppositeLabels), 3_000);
    const target = await firstVisible(buttonByLabels(page, targetLabels), 3_000);

    if (!target) {
      if (alreadyDone) return { changed: false };
      return selectorMiss(page, action, `Не нашёл кнопку «${action}» на странице поста — вероятно, Threads изменил вёрстку`);
    }

    await target.click();
    await page.waitForTimeout(1_200);

    // Репост требует подтверждения в выпадающем меню.
    if (action === "repost" || action === "removeRepost") {
      const confirm = await firstVisible(
        buttonByLabels(page, action === "repost" ? BUTTON_LABELS.confirmRepost : BUTTON_LABELS.removeRepost),
        4_000,
      );
      await confirm?.click().catch(() => undefined);
      await page.waitForTimeout(1_000);
    }

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

export type FeedItem = {
  author: string | null;
  url: string | null;
  text: string;
};

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

      const link = container.locator(POST_PERMALINK).first();
      const href = await link.getAttribute("href").catch(() => null);
      const text = (await container.innerText().catch(() => "")).trim();
      if (!text) continue;

      const url = href ? new URL(href, URLS.home).toString() : null;
      const key = url ?? text.slice(0, 120);
      if (seen.has(key)) continue;

      seen.set(key, { author: authorFromUrl(url), url, text });
    }

    if (seen.size === before) idleRounds += 1;
    else idleRounds = 0;

    if (seen.size < limit) {
      await page.mouse.wheel(0, 2_000);
      await page.waitForTimeout(1_200);
    }
  }

  if (seen.size === 0) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (LOGGED_OUT_HINTS.some((hint) => hint.test(body.slice(0, 2_000)))) {
      session.markLoggedOut();
      throw new ActionError("NEEDS_LOGIN", "Threads показывает страницу для незалогиненных", { retryable: false });
    }
    return selectorMiss(page, label, "Не нашёл ни одного поста — вероятно, Threads изменил вёрстку");
  }

  return [...seen.values()];
}

function authorFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /\/@([^/]+)\/post\//.exec(url);
  return match?.[1] ?? null;
}
