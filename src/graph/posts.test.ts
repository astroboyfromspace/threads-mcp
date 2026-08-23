import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionError } from "../errors.js";
import { GraphClient } from "./client.js";
import { getProfile, getQuota, publish } from "./posts.js";

type Call = { url: string; method: string; body?: string };

/** Подменяет fetch заранее заготовленными ответами и записывает, что уходило наружу. */
function mockFetch(responses: Array<{ status?: number; json: unknown }>): Call[] {
  const calls: Call[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? String(init.body) : undefined,
    });
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("publish", () => {
  it("публикует текстовый пост одним запросом", async () => {
    const calls = mockFetch([{ json: { id: "post-1" } }]);
    const client = new GraphClient("tok");

    const result = await publish(client, "user-1", { mediaType: "TEXT", text: "привет" });

    expect(result).toEqual({ id: "post-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1.0/user-1/threads");
    expect(calls[0]!.body).toContain("auto_publish_text=true");
    expect(calls[0]!.body).toContain("media_type=TEXT");
  });

  it("передаёт reply_to_id, когда это ответ", async () => {
    const calls = mockFetch([{ json: { id: "reply-1" } }]);

    await publish(new GraphClient("tok"), "user-1", {
      mediaType: "TEXT",
      text: "ответ",
      replyToId: "parent-9",
    });

    expect(calls[0]!.body).toContain("reply_to_id=parent-9");
  });

  it("для медиапоста создаёт контейнер, дожидается готовности и публикует", async () => {
    const calls = mockFetch([
      { json: { id: "container-1" } },
      { json: { id: "container-1", status: "FINISHED" } },
      { json: { id: "post-2" } },
    ]);

    const promise = publish(new GraphClient("tok"), "user-1", {
      mediaType: "IMAGE",
      imageUrl: "https://cdn.test/pic.jpg",
      text: "с картинкой",
    });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const result = await promise;

    expect(result).toEqual({ id: "post-2" });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain("container-1");
    expect(calls[1]!.url).toContain("fields=status%2Cerror_message");
    expect(calls[2]!.url).toContain("/threads_publish");
    expect(calls[2]!.body).toContain("creation_id=container-1");
  });

  it("не публикует контейнер, который Threads забраковал", async () => {
    mockFetch([
      { json: { id: "container-2" } },
      { json: { id: "container-2", status: "ERROR", error_message: "битый файл" } },
    ]);

    await expect(
      publish(new GraphClient("tok"), "user-1", { mediaType: "IMAGE", imageUrl: "https://cdn.test/bad.jpg" }),
    ).rejects.toThrow(/битый файл/);
  });

  it("отклоняет текстовый пост без текста, не ходя в сеть", async () => {
    const calls = mockFetch([{ json: {} }]);

    await expect(publish(new GraphClient("tok"), "user-1", { mediaType: "TEXT", text: "   " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(calls).toHaveLength(0);
  });

  it("отклоняет IMAGE без image_url", async () => {
    mockFetch([{ json: {} }]);
    await expect(publish(new GraphClient("tok"), "user-1", { mediaType: "IMAGE" })).rejects.toBeInstanceOf(ActionError);
  });
});

describe("ошибки Graph API", () => {
  it("превращает код 4 в RATE_LIMITED с признаком повторяемости", async () => {
    mockFetch([{ status: 400, json: { error: { message: "Application request limit reached", code: 4 } } }]);

    await expect(publish(new GraphClient("tok"), "user-1", { mediaType: "TEXT", text: "x" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("протухший токен помечает как неповторяемую ошибку", async () => {
    mockFetch([{ status: 400, json: { error: { message: "Session expired", code: 190 } } }]);

    await expect(publish(new GraphClient("tok"), "user-1", { mediaType: "TEXT", text: "x" })).rejects.toMatchObject({
      code: "UPSTREAM",
      retryable: false,
    });
  });

  it("серверную ошибку считает повторяемой", async () => {
    mockFetch([{ status: 500, json: { error: { message: "oops", code: 1 } } }]);

    await expect(publish(new GraphClient("tok"), "user-1", { mediaType: "TEXT", text: "x" })).rejects.toMatchObject({
      code: "UPSTREAM",
      retryable: true,
    });
  });
});

describe("getQuota", () => {
  it("разбирает ответ о квотах", async () => {
    mockFetch([
      {
        json: {
          data: [
            {
              quota_usage: 3,
              config: { quota_total: 250, quota_duration: 86400 },
              reply_quota_usage: 7,
              reply_config: { quota_total: 1000, quota_duration: 86400 },
              delete_quota_usage: 0,
              delete_config: { quota_total: 100, quota_duration: 86400 },
            },
          ],
        },
      },
    ]);

    await expect(getQuota(new GraphClient("tok"), "user-1")).resolves.toEqual({
      posts: { used: 3, total: 250 },
      replies: { used: 7, total: 1000 },
      deletes: { used: 0, total: 100 },
    });
  });

  it("не падает на пустом ответе", async () => {
    mockFetch([{ json: { data: [] } }]);
    const quota = await getQuota(new GraphClient("tok"), "user-1");
    expect(quota.posts).toEqual({ used: 0, total: 250 });
  });
});

describe("getProfile", () => {
  it("отдаёт счётчик подписчиков вместе с профилем, а не отдельным вызовом", async () => {
    const calls = mockFetch([
      { json: { id: "user-1", username: "denisfromspace" } },
      { json: { data: [{ name: "followers_count", total_value: { value: 1234 } }] } },
    ]);

    const profile = await getProfile(new GraphClient("tok"), "user-1");

    expect(profile).toMatchObject({ username: "denisfromspace", follower_count: 1234 });
    expect(calls[1]!.url).toContain("/user-1/threads_insights");
    expect(calls[1]!.url).toContain("metric=followers_count");
  });

  // Счётчик живёт за отдельным разрешением: без него профиль обязан прийти
  // целым, а не превратиться в ошибку из-за необязательного поля.
  it("без разрешения на инсайты отдаёт профиль и объясняет, почему счётчика нет", async () => {
    mockFetch([
      { json: { id: "user-1", username: "denisfromspace" } },
      { status: 400, json: { error: { message: "(#10) Application does not have permission", code: 10 } } },
    ]);

    const profile = await getProfile(new GraphClient("tok"), "user-1");

    expect(profile).toMatchObject({ username: "denisfromspace", follower_count: null });
    expect(String(profile.follower_count_error)).toContain("permission");
  });
});
