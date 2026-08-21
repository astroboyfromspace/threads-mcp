import { describe, expect, it } from "vitest";
import type { Locator } from "playwright";
import type { Page } from "playwright";
import { CARD_TIMEOUT_MS, hiddenRepliesHref, hrefOf, mediaIdFromPageHtml, pkFromShortcode } from "./actions.js";

/**
 * Контейнер-заглушка: запоминает, с какими параметрами у него спросили атрибут.
 * Настоящий Locator сюда не затащить — за ним нужен живой браузер, — а вся
 * проверяемая здесь мысль в том, какие параметры уходят в Playwright.
 */
function fakeContainer(getAttribute: (name: string, options?: { timeout?: number }) => Promise<string | null>) {
  const calls: Array<{ name: string; options?: { timeout?: number } }> = [];
  const container = {
    locator: () => ({
      first: () => ({
        getAttribute: (name: string, options?: { timeout?: number }) => {
          calls.push({ name, options });
          return getAttribute(name, options);
        },
      }),
    }),
  } as unknown as Locator;
  return { container, calls };
}

describe("чтение ссылки на пост", () => {
  // Тот самый случай из утреннего прогона 2026-08-21: Threads убирает
  // контейнер из DOM при виртуальном скролле, локатор ждёт его появления, и
  // без своего потолка ожидание тянется дефолтные 30 секунд Playwright. За
  // прогон таких карточек набиралось полтора десятка — 424 секунды из 493.
  it("ограничено потолком ожидания карточки, а не умолчанием Playwright", async () => {
    const { container, calls } = fakeContainer(async () => "/@user/post/abc");

    await hrefOf(container);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.timeout).toBe(CARD_TIMEOUT_MS);
  });

  it("пропавшая карточка отдаёт null, а не роняет обход", async () => {
    const { container } = fakeContainer(async () => {
      throw new Error("locator.getAttribute: Timeout 2000ms exceeded");
    });

    await expect(hrefOf(container)).resolves.toBeNull();
  });

  it("контейнер без пермалинка — законный случай, тоже null", async () => {
    const { container } = fakeContainer(async () => null);

    await expect(hrefOf(container)).resolves.toBeNull();
  });
});

/** Страница-заглушка: та же мысль, что и с контейнером, — важны параметры вызова. */
function fakePage(getAttribute: () => Promise<string | null>) {
  const calls: Array<{ options?: { timeout?: number } }> = [];
  const page = {
    locator: () => ({
      first: () => ({
        getAttribute: (_name: string, options?: { timeout?: number }) => {
          calls.push({ options });
          return getAttribute();
        },
      }),
    }),
  } as unknown as Page;
  return { page, calls };
}

describe("ссылка на скрытые ответы", () => {
  // Ссылка необязательная: под большинством постов скрытых ответов нет, и
  // ожидание умолчанием в 30 секунд платилось почти на каждом read_replies.
  it("ограничена потолком ожидания карточки", async () => {
    const { page, calls } = fakePage(async () => "/hidden_replies/abc");

    await expect(hiddenRepliesHref(page)).resolves.toBe("/hidden_replies/abc");
    expect(calls[0]!.options?.timeout).toBe(CARD_TIMEOUT_MS);
  });

  it("нет скрытых ответов — null, а не ошибка", async () => {
    const { page } = fakePage(async () => {
      throw new Error("locator.getAttribute: Timeout 2000ms exceeded");
    });

    await expect(hiddenRepliesHref(page)).resolves.toBeNull();
  });
});

describe("media ID поста", () => {
  // Шорткод кодирует инстаграмный pk (~3.9e18), а Graph API работает с
  // числами вида 17…/18…. Пара ниже снята с живого поста: id из
  // list_my_posts против шорткода из его же пермалинка.
  it("шорткод разворачивается в pk, а не в media ID", () => {
    expect(pkFromShortcode("DcLvO4mCFho")).toBe("3966471627856173160");
    expect(pkFromShortcode("DavZFN9DdZ6")).toBe("3940478508715595386");
  });

  it("посторонний символ в шорткоде — null, а не мусорное число", () => {
    expect(pkFromShortcode("DcLvO4mCFh*")).toBeNull();
  });

  // Так этот кусок выглядит в данных страницы поста: pk и рядом
  // text_post_app_info.id — он же media ID из Graph API.
  const POST = (pk: string, mediaId: string) =>
    `{"pk":"${pk}","like_count":3,"text_post_app_info":{"direct_reply_count":5,` +
    `"id":"XDTTextPostAppMediaInfo:${mediaId}"},"id":"${pk}_76098754985"}`;

  it("по pk достаёт media ID из данных страницы", () => {
    expect(mediaIdFromPageHtml(POST("3966471627856173160", "18092329220390633"), "3966471627856173160")).toBe(
      "18092329220390633",
    );
  });

  // На странице поста лежат ещё и ответы — у каждого свой pk и свой media ID.
  // Ошибиться постом здесь значит ответить не тому человеку.
  it("среди ответов берёт media ID именно нужного поста", () => {
    const html = [POST("111", "17976730128065505"), POST("222", "18143899879488572"), POST("333", "17980072392110306")].join(",");

    expect(mediaIdFromPageHtml(html, "222")).toBe("18143899879488572");
    expect(mediaIdFromPageHtml(html, "333")).toBe("17980072392110306");
  });

  it("поста на странице нет — null, а не чужой ID", () => {
    expect(mediaIdFromPageHtml(POST("111", "17976730128065505"), "999")).toBeNull();
  });
});
