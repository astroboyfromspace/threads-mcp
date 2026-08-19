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
    // Смешанная выборка нарочно: "a" падает, "b" отрабатывает честно и сразу
    // добирает цель. Если бы это было падение всех слов подряд, тай-брейк по
    // алфавиту дал бы тот же порядок что с багом, что без него, и тест не
    // отличал бы одно от другого.
    const client = fakeClient(0);
    client.searchPosts = vi.fn(async (query: string) => {
      if (query === "a") throw Object.assign(new Error("сломалось"), { code: "INTERNAL" });
      return { query, posts: [card(`https://t/${query}`)] };
    });
    let tick = 0;
    const now = () => (tick += 1_000);

    await runCollection({ db, client, sleep: async () => {}, now }, { target: 1, limit: 1 });

    // "a" провалилось и осталось без last_run_at — как и нетронутое "c"
    // (до него прогон не дошёл: цель уже добрана словом "b"). "b" честно
    // отработало и получило last_run_at. Тай-брейк по алфавиту разводит "a"
    // и "c": ожидаемый порядок — a, c, b. Если бы recordError выставлял
    // last_run_at как recordRun (регрессия), "a" получило бы метку раньше
    // "b", и порядок стал бы c, a, b — этот тест такую мутацию ловит.
    expect(db.nextQueries(3)).toEqual(["a", "c", "b"]);
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
      const sleep = vi.fn(async () => {});

      await runCollection({ db, client, sleep }, { target: 1000, limit: 1 });

      // "a" не даётся: исходный заход плюс три повтора — ровно четыре вызова
      // именно с этим словом — и только тогда слово засчитывается неудачным.
      const callsForA = client.searchPosts.mock.calls.filter(([query]) => query === "a");
      expect(callsForA).toHaveLength(4);
      expect(db.lastError("a")).toBe("RATE_LIMITED");

      // Растущая пауза перед первыми тремя повторами слова "a" — они идут
      // первыми, до любых других пауз в прогоне (между словами, для "b"/"c").
      expect(sleep).toHaveBeenNthCalledWith(1, 60_000);
      expect(sleep).toHaveBeenNthCalledWith(2, 180_000);
      expect(sleep).toHaveBeenNthCalledWith(3, 600_000);
    });

    it("исчерпанная суточная квота (retry_after больше 15 минут) обрывает весь прогон, а не только слово", async () => {
      const client = fakeClient(0);
      client.searchPosts = vi.fn(async () => {
        throw Object.assign(new Error("суточный лимит исчерпан"), { code: "RATE_LIMITED", retry_after: 3_600 });
      });
      const sleep = vi.fn(async () => {});

      const report = await runCollection({ db, client, sleep }, { target: 1000, limit: 1 });

      // Ни одной попытки повтора и ни одной паузы: час ждать ради одного
      // слова бессмысленно, квота не восстановится раньше завтра.
      expect(client.searchPosts).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(report.stoppedBy).toBe("rate_limited");
    });

    it("пауза из retry_after в любом случае ограничена потолком в 15 минут", async () => {
      const client = fakeClient(0);
      let call = 0;
      client.searchPosts = vi.fn(async (query: string) => {
        call += 1;
        // Ровно на потолке (900с) — это ещё короткая пауза, повтор должен случиться.
        if (call === 1) throw Object.assign(new Error("лимит"), { code: "RATE_LIMITED", retry_after: 900 });
        return { query, posts: [card(`https://t/ok-${call}`)] };
      });
      const sleep = vi.fn(async () => {});

      await runCollection({ db, client, sleep }, { target: 1, limit: 1 });

      expect(sleep).toHaveBeenCalledWith(900_000);
      expect(client.searchPosts).toHaveBeenCalledTimes(2);
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

  // Битую ссылку — ту, которую не разбирает конструктор URL, — считаем
  // отсутствующей: пост пропускается, как и пост без url вовсе.
  it("пропускает пост с неразбираемой ссылкой", async () => {
    const client = fakeClient(0);
    client.searchPosts = vi.fn(async (query: string) => ({
      query,
      // Относительный путь без протокола и хоста — new URL() без базового
      // адреса бросает TypeError на такой строке.
      posts: [{ ...card("/post/1"), author: "someone" }, { ...card("https://t/post/2"), author: "someone" }],
    }));

    const report = await runCollection({ db, client, sleep: async () => {} }, { target: 1000, limit: 2 });

    expect(db.totalPosts()).toBe(1);
    expect(db.allPosts()[0]!.url).toBe("https://t/post/2");
    // Все три слова ротации ("a", "b", "c") находят одну и ту же битую
    // ссылку — по одному отброшенному посту на каждое.
    expect(report.droppedNoUrl).toBe(3);
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
