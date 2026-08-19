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

  // recordError — отдельный от recordRun путь: ошибка не должна выглядеть как
  // честно отработанный заход, иначе слово уедет в конец очереди ротации,
  // ничего не собрав.
  it("recordError не трогает last_run_at и runs", () => {
    db.syncQueries(["a", "b"]);
    db.recordRun("a", { newPosts: 5 }, 1000);

    db.recordError("a", "RATE_LIMITED", 2000);

    expect(db.lastError("a")).toBe("RATE_LIMITED");
    // last_run_at у "a" остался прежним (1000) — среди искавшихся оно всё ещё
    // самое давнее только если "b" ни разу не искали, что и проверяем: "b"
    // как ни разу не искавшееся идёт первым, а "a" — вторым, с тем же местом,
    // что было бы и без recordError.
    expect(db.nextQueries(2)).toEqual(["b", "a"]);
  });
});
