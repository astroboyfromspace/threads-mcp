import { describe, expect, it } from "vitest";
import type { Locator } from "playwright";
import { CARD_TIMEOUT_MS, hrefOf } from "./actions.js";

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
