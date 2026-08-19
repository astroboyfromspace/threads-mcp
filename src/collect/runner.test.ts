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

  // Разные показы одной и той же карточки несут разные трекинговые параметры —
  // без нормализации ссылки дедуп по PRIMARY KEY не срабатывает и пост
  // ложится несколькими строками.
  it("нормализует ссылку перед дедупом — трекинговые параметры не создают дубль", async () => {
    const client = fakeClient(0);
    client.searchPosts = vi.fn(async (query: string) => ({
      query,
      posts: [
        { ...card("https://t/post/1?xmt=abc123"), author: "someone" },
        { ...card("https://t/post/1?igshid=xyz789#reply"), author: "someone" },
      ],
    }));

    await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 2 });

    expect(db.totalPosts()).toBe(1);
    expect(db.allPosts()[0]!.url).toBe("https://t/post/1");
  });

  // Пауза нужна между запросами, а не после последнего — ждать перед выходом незачем.
  it("не спит после последнего слова", async () => {
    const client = fakeClient(1);
    const sleep = vi.fn(async () => {});

    const report = await runCollection({ db, client, sleep }, { target: 1000, limit: 1 });

    expect(report.stoppedBy).toBe("queries_exhausted");
    expect(sleep).toHaveBeenCalledTimes(client.searchPosts.mock.calls.length - 1);
  });
});
