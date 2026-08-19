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
