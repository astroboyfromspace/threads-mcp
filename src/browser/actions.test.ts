import { describe, expect, it } from "vitest";
import type { Locator } from "playwright";
import type { Page } from "playwright";
import {
  CARD_TIMEOUT_MS,
  hiddenRepliesHref,
  hrefOf,
  isPostPage,
  mediaIdFromPageHtml,
  mediaIdFromPostRef,
  pkFromShortcode,
  upstreamErrorShown,
} from "./actions.js";

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

// Отчёт 2026-08-25 звучал как «Threads изменил разметку», а в журнале действий
// у всех трёх падений в ссылке вместо шорткода стоял media ID из
// get_conversation: /@denisfromspace/post/17967428262139577. Страницы по такому
// адресу нет, Threads уводит на профиль — и поиск media ID честно ничего не
// находил.
describe("media ID вместо шорткода", () => {
  it("длинное число — это уже media ID, разворачивать нечего", () => {
    expect(mediaIdFromPostRef("17967428262139577")).toBe("17967428262139577");
    expect(mediaIdFromPostRef("https://www.threads.com/@denisfromspace/post/17967428262139577")).toBe(
      "17967428262139577",
    );
  });

  it("шорткод остаётся шорткодом", () => {
    expect(mediaIdFromPostRef("DcLvO4mCFho")).toBeNull();
    expect(mediaIdFromPostRef("https://www.threads.net/@attorneyryan/post/Dccqts8FOA6")).toBeNull();
  });

  // Шорткоды короткие (11 символов), и цифровой шорткод теоретически возможен —
  // принимать его за media ID нельзя.
  it("короткое число за media ID не принимаем", () => {
    expect(mediaIdFromPostRef("12345678901")).toBeNull();
  });

  it("страница поста отличается от профиля, куда уводит несуществующий адрес", () => {
    expect(isPostPage("https://www.threads.com/@attorneyryan/post/Dccqts8FOA6")).toBe(true);
    expect(isPostPage("https://www.threads.com/@denisfromspace")).toBe(false);
  });
});

describe("страница-заглушка Threads", () => {
  // Инцидент 2026-09-05: read_replies падал на 100% чужих постов с
  // SELECTOR_MISS «Threads изменил вёрстку». На снимках промаха вёрстка была
  // цела — Threads вместо поста рисовал свою заглушку «Something went wrong»
  // с кнопкой Retry. То же самое ловил и read_profile. Сбой чужой и
  // временный, а мы объявляли его своей фатальной поломкой.
  it("узнаётся по тексту, когда содержимого на странице нет", async () => {
    const page = fakeBody(0, "Профиль\nSomething went wrong, please try again later.\nRetry");

    await expect(upstreamErrorShown(page)).resolves.toBe(true);
  });

  it("узнаётся и по-русски: язык интерфейса зависит от аккаунта", async () => {
    const page = fakeBody(0, "Что-то пошло не так. Повторите попытку позже.");

    await expect(upstreamErrorShown(page)).resolves.toBe(true);
  });

  // Иначе пост, в тексте которого есть «something went wrong», выдавал бы
  // себя за сбой Threads и обрывал бы чтение живой ленты.
  it("пост с такими же словами в тексте заглушкой не считается", async () => {
    const page = fakeBody(7, "something went wrong with my deploy today");

    await expect(upstreamErrorShown(page)).resolves.toBe(false);
  });

  it("обычная пустая страница — не заглушка", async () => {
    const page = fakeBody(0, "For you\nNew thread\nSearch");

    await expect(upstreamErrorShown(page)).resolves.toBe(false);
  });
});

/** Страница, у которой спрашивают только число контейнеров и текст body. */
function fakeBody(containers: number, text: string): Page {
  return {
    locator: (selector: string) => ({
      count: async () => containers,
      innerText: async () => (selector === "body" ? text : ""),
    }),
  } as unknown as Page;
}
