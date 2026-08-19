import { describe, expect, it } from "vitest";
import { authorFromUrl, buildCard, classifyMedia, parseCount } from "./cards.js";

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

  // Регэксп нашёл что-то похожее на число, но Number() его не разобрал —
  // выдуманный ноль тут хуже пустого значения: он молча соврёт в датасет.
  it("нераспознанное число — null, а не ноль", () => {
    // Несколько точек в дробной части — Number() не разбирает такую строку,
    // а регэксп её уже принял как число.
    expect(parseCount("Like 1.2.3K")).toBeNull();
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
