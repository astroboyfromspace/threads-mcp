import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Драйверы подменяются до импорта реестра: он захватывает их на этапе загрузки модуля.
vi.mock("../src/graph/posts.js", () => ({
  publish: vi.fn(async () => ({ id: "graph-post" })),
  listMyPosts: vi.fn(async () => ({ data: [] })),
  listMyReplies: vi.fn(async () => ({ data: [] })),
  getConversation: vi.fn(async () => ({ data: [] })),
  deletePost: vi.fn(async () => ({ success: true })),
  getQuota: vi.fn(async () => ({ posts: { used: 0, total: 250 } })),
  getProfile: vi.fn(async () => ({ id: "me" })),
}));

vi.mock("../src/graph/token.js", () => ({
  getClient: vi.fn(async () => ({ client: {} as never, userId: "user-1" })),
}));

vi.mock("../src/browser/actions.js", () => ({
  likePost: vi.fn(async () => ({ changed: true })),
  unlikePost: vi.fn(async () => ({ changed: true })),
  followUser: vi.fn(async () => ({ changed: true })),
  unfollowUser: vi.fn(async () => ({ changed: true })),
  repost: vi.fn(async () => ({ changed: true })),
  removeRepost: vi.fn(async () => ({ changed: true })),
  readFeed: vi.fn(async () => [
    {
      author: "someone",
      url: null,
      text: "пост",
      publishedAt: null,
      likes: 0,
      replies: 0,
      reposts: 0,
      media: "none",
      mediaCount: 0,
    },
  ]),
  readProfile: vi.fn(async () => ({ username: "someone", posts: [] })),
  readReplies: vi.fn(async () => ({ url: "https://www.threads.net/@someone/post/abc", post: null, replies: [] })),
}));

vi.mock("../src/browser/session.js", () => ({
  assertLoggedIn: vi.fn(),
  session: {
    checkLogin: vi.fn(async () => ({ loggedIn: true })),
    markLoggedIn: vi.fn(),
    markLoggedOut: vi.fn(),
    needsLogin: false,
    queueDepth: 0,
  },
}));

const graph = await import("../src/graph/posts.js");
const browser = await import("../src/browser/actions.js");
const sessionModule = await import("../src/browser/session.js");
const { execute, describeActions } = await import("../src/actions/registry.js");
const { getDb } = await import("../src/db.js");

beforeEach(() => {
  getDb().exec("DELETE FROM action_log");
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("маршрутизация действий", () => {
  it("публикацию отправляет в Graph, а не в браузер", async () => {
    await execute("publish_post", { text: "привет" });

    expect(graph.publish).toHaveBeenCalledTimes(1);
    expect(vi.mocked(graph.publish).mock.calls[0]![2]).toMatchObject({ mediaType: "TEXT", text: "привет" });
    expect(browser.likePost).not.toHaveBeenCalled();
  });

  it("лайк отправляет в браузер, а не в Graph", async () => {
    await execute("like_post", { url: "https://www.threads.net/@someone/post/abc" });

    expect(browser.likePost).toHaveBeenCalledWith({ url: "https://www.threads.net/@someone/post/abc" });
    expect(graph.publish).not.toHaveBeenCalled();
  });

  it("комментарии под чужим постом читает браузером, а не Graph", async () => {
    await execute("read_replies", { url: "https://www.threads.net/@someone/post/abc" });

    expect(browser.readReplies).toHaveBeenCalledWith("https://www.threads.net/@someone/post/abc", 20);
    expect(graph.getConversation).not.toHaveBeenCalled();
  });

  it("определяет тип медиа по переданному URL", async () => {
    await execute("publish_post", { text: "с картинкой", image_url: "https://cdn.test/a.jpg" });
    expect(vi.mocked(graph.publish).mock.calls[0]![2]).toMatchObject({ mediaType: "IMAGE" });

    vi.clearAllMocks();
    await execute("publish_post", { text: "с видео", video_url: "https://cdn.test/a.mp4" });
    expect(vi.mocked(graph.publish).mock.calls[0]![2]).toMatchObject({ mediaType: "VIDEO" });
  });

  it("ответ передаёт reply_to_id в Graph", async () => {
    await execute("reply_to_post", { reply_to_id: "parent-1", text: "ответ" });
    expect(vi.mocked(graph.publish).mock.calls[0]![2]).toMatchObject({ replyToId: "parent-1" });
  });
});

describe("валидация входа", () => {
  it("отвергает ссылку не на Threads", async () => {
    await expect(execute("like_post", { url: "https://example.com/post/1" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(browser.likePost).not.toHaveBeenCalled();
  });

  it("отвергает ответ без текста", async () => {
    await expect(execute("reply_to_post", { reply_to_id: "x", text: "" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("срезает собаку у username", async () => {
    await execute("follow_user", { username: "@someone" });
    expect(browser.followUser).toHaveBeenCalledWith("someone");
  });

  it("подставляет значение по умолчанию для лимита ленты", async () => {
    await execute("read_feed", {});
    expect(browser.readFeed).toHaveBeenCalledWith(20);
  });
});

describe("суточные лимиты браузерных действий", () => {
  it("блокирует действие после исчерпания лимита", async () => {
    vi.stubEnv("LIMIT_FOLLOWS_PER_DAY", "2");
    vi.resetModules();
    const { execute: freshExecute } = await import("../src/actions/registry.js");
    const { getDb: freshDb } = await import("../src/db.js");
    freshDb().exec("DELETE FROM action_log");

    await freshExecute("follow_user", { username: "a" });
    await freshExecute("follow_user", { username: "b" });

    await expect(freshExecute("follow_user", { username: "c" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("не ограничивает Graph-действия собственным лимитом", async () => {
    for (let i = 0; i < 5; i += 1) {
      await execute("publish_post", { text: `пост ${i}` });
    }
    expect(graph.publish).toHaveBeenCalledTimes(5);
  });

  it("неудачные попытки не съедают лимит", async () => {
    vi.mocked(browser.likePost).mockRejectedValueOnce(new Error("не вышло"));

    await expect(execute("like_post", { url: "https://www.threads.net/@a/post/1" })).rejects.toThrow();

    const row = getDb()
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM action_log WHERE action = 'like_post' AND ok = 1")
      .get();
    expect(row?.n).toBe(0);
  });
});

describe("журнал действий", () => {
  it("записывает успех вместе с драйвером", async () => {
    await execute("publish_post", { text: "в журнал" });

    const row = getDb()
      .prepare<[], { action: string; driver: string; ok: number }>(
        "SELECT action, driver, ok FROM action_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row).toMatchObject({ action: "publish_post", driver: "graph", ok: 1 });
  });

  it("записывает неудачу с кодом ошибки", async () => {
    await expect(execute("like_post", { url: "не ссылка" })).rejects.toThrow();

    const row = getDb()
      .prepare<[], { error_code: string; ok: number }>(
        "SELECT error_code, ok FROM action_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row).toMatchObject({ error_code: "INVALID_INPUT", ok: 0 });
  });
});

describe("разлогиненная сессия", () => {
  it("не пускает браузерные действия, но пропускает Graph", async () => {
    vi.mocked(sessionModule.assertLoggedIn).mockImplementationOnce(() => {
      throw Object.assign(new Error("нужен вход"), { code: "NEEDS_LOGIN" });
    });

    await expect(execute("like_post", { url: "https://www.threads.net/@a/post/1" })).rejects.toThrow("нужен вход");

    await expect(execute("publish_post", { text: "а это работает" })).resolves.toEqual({ id: "graph-post" });
  });
});

describe("describeActions", () => {
  it("перечисляет действия с драйвером и лимитом", () => {
    const described = describeActions();
    const like = described.find((a) => a.name === "like_post");
    const publish = described.find((a) => a.name === "publish_post");

    expect(like).toMatchObject({ driver: "browser" });
    expect(like?.daily_limit).toBeGreaterThan(0);
    expect(publish).toMatchObject({ driver: "graph", daily_limit: null });
  });
});
