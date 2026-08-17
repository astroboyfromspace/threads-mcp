import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/actions/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/actions/registry.js")>();
  return { ...actual, execute: vi.fn() };
});

vi.mock("../src/browser/session.js", () => ({
  assertLoggedIn: vi.fn(),
  session: { needsLogin: false, queueDepth: 0, checkLogin: vi.fn(), markLoggedIn: vi.fn(), markLoggedOut: vi.fn() },
}));

const { execute } = await import("../src/actions/registry.js");
const { buildServer } = await import("../src/http/server.js");
const { ActionError } = await import("../src/errors.js");

const app = buildServer();
const AUTH = { authorization: "Bearer test-token" };

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("авторизация", () => {
  it("не пускает без токена", async () => {
    const response = await app.inject({ method: "POST", url: "/actions/publish_post", payload: { text: "x" } });
    expect(response.statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("не пускает с неверным токеном", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/actions/publish_post",
      headers: { authorization: "Bearer wrong-token" },
      payload: { text: "x" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("не пускает с токеном другой длины", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/actions",
      headers: { authorization: "Bearer short" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("health доступен без токена — чтобы мониторинг не требовал секретов", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });
});

describe("выполнение действий", () => {
  it("передаёт тело действия и возвращает результат", async () => {
    vi.mocked(execute).mockResolvedValueOnce({ id: "post-1" });

    const response = await app.inject({
      method: "POST",
      url: "/actions/publish_post",
      headers: AUTH,
      payload: { text: "привет" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { id: "post-1" } });
    expect(execute).toHaveBeenCalledWith("publish_post", { text: "привет" });
  });

  it("на неизвестное действие отвечает 404", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/actions/делай_красиво",
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("INVALID_INPUT");
  });

  it("/post — синоним публикации", async () => {
    vi.mocked(execute).mockResolvedValueOnce({ id: "post-2" });

    const response = await app.inject({ method: "POST", url: "/post", headers: AUTH, payload: { text: "коротко" } });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith("publish_post", { text: "коротко" });
  });
});

describe("коды ошибок", () => {
  const cases = [
    { code: "INVALID_INPUT" as const, status: 400 },
    { code: "RATE_LIMITED" as const, status: 429 },
    { code: "NEEDS_LOGIN" as const, status: 503 },
    { code: "UPSTREAM" as const, status: 502 },
    { code: "SELECTOR_MISS" as const, status: 500 },
  ];

  for (const { code, status } of cases) {
    it(`${code} превращается в HTTP ${status}`, async () => {
      vi.mocked(execute).mockRejectedValueOnce(new ActionError(code, "тестовая ошибка"));

      const response = await app.inject({ method: "POST", url: "/actions/like_post", headers: AUTH, payload: {} });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ ok: false, error: { code, message: "тестовая ошибка" } });
    });
  }

  it("отдаёт retry-after, когда он известен", async () => {
    vi.mocked(execute).mockRejectedValueOnce(
      new ActionError("RATE_LIMITED", "лимит", { retryAfterSeconds: 3600 }),
    );

    const response = await app.inject({ method: "POST", url: "/actions/follow_user", headers: AUTH, payload: {} });

    expect(response.headers["retry-after"]).toBe("3600");
    expect(response.json().error.retry_after).toBe(3600);
  });

  it("непредвиденное исключение не роняет сервер и не течёт наружу деталями", async () => {
    vi.mocked(execute).mockRejectedValueOnce(new Error("внутренняя поломка"));

    const response = await app.inject({ method: "POST", url: "/actions/read_feed", headers: AUTH, payload: {} });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL");
  });
});

describe("GET /actions", () => {
  it("перечисляет доступные действия", async () => {
    const response = await app.inject({ method: "GET", url: "/actions", headers: AUTH });

    expect(response.statusCode).toBe(200);
    const names = response.json().data.map((a: { name: string }) => a.name);
    expect(names).toContain("publish_post");
    expect(names).toContain("like_post");
  });
});
