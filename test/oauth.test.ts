import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/browser/session.js", () => ({
  assertLoggedIn: vi.fn(),
  session: { needsLogin: false, queueDepth: 0, checkLogin: vi.fn(), markLoggedIn: vi.fn(), markLoggedOut: vi.fn() },
}));

const { buildServer } = await import("../src/http/server.js");
const { buildAuthorizationUrl } = await import("../src/graph/token.js");
const { getDb } = await import("../src/db.js");

const app = buildServer();
const AUTH = { authorization: "Bearer test-token" };

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  getDb().exec("DELETE FROM oauth_state; DELETE FROM token;");
  vi.unstubAllGlobals();
});

/** Достаёт state из ссылки авторизации — так его увидел бы владелец в браузере. */
function issueState(): string {
  const url = new URL(buildAuthorizationUrl(["threads_basic"]));
  const state = url.searchParams.get("state");
  if (!state) throw new Error("buildAuthorizationUrl не выдал state");
  return state;
}

describe("ссылка авторизации", () => {
  it("содержит state", () => {
    const url = new URL(buildAuthorizationUrl(["threads_basic"]));
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
  });

  it("каждый раз выдаёт новый state", () => {
    expect(issueState()).not.toBe(issueState());
  });
});

describe("защита callback от подмены аккаунта", () => {
  it("отвергает код без state", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/callback?code=чужой-код" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/state/i);
  });

  it("отвергает код с выдуманным state", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback?code=чужой-код&state=придуманный",
    });

    expect(response.statusCode).toBe(400);
  });

  it("не сохраняет токен при отклонённом callback", async () => {
    // fetch не подменяем: если проверка state пропустит запрос, тест упадёт на
    // реальной сетевой попытке, а не тихо пройдёт.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await app.inject({ method: "GET", url: "/oauth/callback?code=чужой-код&state=придуманный" });

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM token").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("принимает код с настоящим state", async () => {
    const state = issueState();

    // user_id из обмена кода (42) не совпадает с настоящим id аккаунта (48) —
    // Meta действительно так отвечает. Сохраняться должен id из ручки me.
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = String(input);
      if (url.includes("oauth/access_token")) {
        return Response.json({ access_token: "short-lived", user_id: 42 });
      }
      if (url.includes("/me")) {
        return Response.json({ id: "48" });
      }
      return Response.json({ access_token: "long-lived", token_type: "bearer", expires_in: 5_183_944 });
    });

    const response = await app.inject({ method: "GET", url: `/oauth/callback?code=наш-код&state=${state}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("user_id=48");

    const row = getDb().prepare("SELECT user_id FROM token WHERE id = 1").get() as { user_id: string };
    expect(row.user_id).toBe("48");
  });

  it("state одноразовый — повторный переход отклоняется", async () => {
    const state = issueState();
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = String(input);
      if (url.includes("oauth/access_token")) {
        return Response.json({ access_token: "short-lived", user_id: 42 });
      }
      if (url.includes("/me")) {
        return Response.json({ id: "48" });
      }
      return Response.json({ access_token: "long-lived", token_type: "bearer", expires_in: 5_183_944 });
    });

    const first = await app.inject({ method: "GET", url: `/oauth/callback?code=наш-код&state=${state}` });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: `/oauth/callback?code=повтор&state=${state}` });
    expect(second.statusCode).toBe(400);
  });

  it("просроченный state не принимается", async () => {
    const state = issueState();
    // Отматываем время выдачи на 16 минут назад: TTL — 15.
    getDb()
      .prepare("UPDATE oauth_state SET created_at = ? WHERE state = ?")
      .run(Math.floor(Date.now() / 1000) - 16 * 60, state);

    const response = await app.inject({ method: "GET", url: `/oauth/callback?code=наш-код&state=${state}` });
    expect(response.statusCode).toBe(400);
  });

  it("отказ пользователя обрабатывается отдельно от подмены", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback?error=access_denied&error_description=Пользователь+отказал",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("отказал");
  });
});

describe("/oauth/start", () => {
  it("требует bearer-токен", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/start" });
    expect(response.statusCode).toBe(401);
  });

  it("с токеном редиректит на Threads со state", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/start", headers: AUTH });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.host).toBe("threads.net");
    expect(location.searchParams.get("state")).toBeTruthy();
  });
});
