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

  // Неверный токен иначе сжигает всю ротацию: слова получают свежий
  // last_run_at и ноль постов, хотя ничего не собрали.
  it("ошибка слова не двигает его в ротации — recordRun не зовётся", async () => {
    const client = fakeClient(0);
    client.searchPosts = vi.fn(async () => {
      throw Object.assign(new Error("сломалось"), { code: "INTERNAL" });
    });

    await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 1 });

    // Слово "a" (первым по алфавиту среди ни разу не искавшихся) провалилось,
    // но раз last_run_at не выставился, при следующем прогоне оно снова
    // окажется первым в очереди — как и было до захода.
    expect(db.nextQueries(3)).toEqual(["a", "b", "c"]);
    expect(db.lastError("a")).toBe("INTERNAL");
  });

  // Пять неудачных слов подряд — явный признак сломанного прогона (например,
  // неверный токен), а не невезения на конкретных словах.
  it("останавливается после пяти неудачных слов подряд", async () => {
    db.syncQueries(["d", "e"]); // теперь 5 слов: a..e
    const client = fakeClient(0);
    client.searchPosts = vi.fn(async () => {
      throw Object.assign(new Error("сломалось"), { code: "INTERNAL" });
    });

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 1 });

    expect(report.stoppedBy).toBe("too_many_errors");
    expect(client.searchPosts).toHaveBeenCalledTimes(5);
  });

  // Успешный заход должен сбрасывать счётчик подряд идущих неудач.
  it("успех между неудачами не даёт прогону остановиться раньше времени", async () => {
    db.syncQueries(["d", "e", "f", "g"]); // теперь 7 слов
    const client = fakeClient(1);
    let call = 0;
    client.searchPosts = vi.fn(async (query: string) => {
      call += 1;
      // Неудача, неудача, успех, неудача, неудача, неудача, неудача — без
      // сброса счётчика прогон встал бы на четвёртой; со сбросом он проходит
      // всю ротацию до конца.
      if (call === 3) return { query, posts: [card(`https://t/ok-${call}`)] };
      throw Object.assign(new Error("сломалось"), { code: "INTERNAL" });
    });

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 1 });

    expect(report.stoppedBy).toBe("queries_exhausted");
    expect(client.searchPosts).toHaveBeenCalledTimes(7);
  });

  describe("повтор на RATE_LIMITED", () => {
    it("повторяет то же слово, а не переходит к следующему", async () => {
      const client = fakeClient(0);
      let call = 0;
      client.searchPosts = vi.fn(async (query: string) => {
        call += 1;
        if (call === 1) throw Object.assign(new Error("лимит"), { code: "RATE_LIMITED" });
        return { query, posts: [card(`https://t/ok-${call}`)] };
      });
      const sleep = vi.fn(async () => {});

      const report = await runCollection({ db, client, sleep }, { target: 1, limit: 1 });

      expect(client.searchPosts).toHaveBeenNthCalledWith(1, "a", 1);
      expect(client.searchPosts).toHaveBeenNthCalledWith(2, "a", 1);
      expect(report.newPosts).toBe(1);
      expect(report.errors).toBe(0);
      // Пауза по умолчанию — растущая, первая ступень 60 секунд.
      expect(sleep).toHaveBeenCalledWith(60_000);
    });

    it("берёт паузу из retry_after ответа, если он есть", async () => {
      const client = fakeClient(0);
      let call = 0;
      client.searchPosts = vi.fn(async (query: string) => {
        call += 1;
        if (call === 1) throw Object.assign(new Error("лимит"), { code: "RATE_LIMITED", retry_after: 5 });
        return { query, posts: [card(`https://t/ok-${call}`)] };
      });
      const sleep = vi.fn(async () => {});

      await runCollection({ db, client, sleep }, { target: 1, limit: 1 });

      expect(sleep).toHaveBeenCalledWith(5_000);
    });

    it("после исчерпания повторов слово считается неудачным", async () => {
      const client = fakeClient(0);
      client.searchPosts = vi.fn(async () => {
        throw Object.assign(new Error("лимит"), { code: "RATE_LIMITED" });
      });

      const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 1 });

      // "a" не даётся: исходный заход плюс три повтора — четыре вызова — и
      // только тогда слово засчитывается неудачным.
      expect(client.searchPosts).toHaveBeenCalledWith("a", 1);
      expect(db.lastError("a")).toBe("RATE_LIMITED");
    });
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
  // Раньше карточки без ссылки терялись беззвучно: отчёт вообще не знал об
  // их существовании.
  // Лог ленты должен показывать именно то, что добавила лента, а не
  // накопленный newPosts, — иначе при любой перестановке шагов лог начнёт
  // врать.
  it("лог ленты показывает локально добавленное, а не накопленный счёт", async () => {
    const client = fakeClient(3);
    const messages: string[] = [];

    await runCollection({ db, client, sleep: async () => {}, log: (m) => messages.push(m) }, { target: 3, limit: 3 });

    expect(messages[0]).toBe("лента: +3");
  });

  it("считает и показывает в отчёте посты без ссылки", async () => {
    const client = fakeClient(0);
    client.readFeed = vi.fn(async () => [{ ...card("https://t/feed-1") }, { ...card("https://t/feed-1"), url: null }]);
    client.searchPosts = vi.fn(async (query: string) => ({
      query,
      posts: [{ ...card("https://t/1"), url: null }, { ...card("https://t/2") }],
    }));

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 2 });

    // Один без ссылки в ленте плюс по одному без ссылки на каждое из трёх
    // слов ротации ("a", "b", "c").
    expect(report.droppedNoUrl).toBe(1 + 3);
  });

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
