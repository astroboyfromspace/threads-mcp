import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { actions, describeActions, execute, isActionName } from "../actions/registry.js";
import { httpStatusFor, toEnvelope, ActionError } from "../errors.js";
import { session } from "../browser/session.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  persistLongLivedToken,
  verifyOAuthState,
} from "../graph/token.js";
import { loadToken } from "../db.js";

const OAUTH_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
] as const;

/** Сравнение токена без утечки времени: обычное === выдаёт длину общего префикса. */
function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(config.apiToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !tokenMatches(provided)) {
    reply.code(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "Нужен корректный Bearer-токен", retryable: false } });
    return false;
  }
  return true;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 5 * 1024 * 1024,
  });

  app.get("/health", async () => {
    const token = loadToken();
    return {
      ok: true,
      data: {
        graph_token: token
          ? { user_id: token.userId, expires_at: new Date(token.expiresAt * 1000).toISOString() }
          : null,
        browser: { needs_login: session.needsLogin, queue_depth: session.queueDepth },
      },
    };
  });

  app.get("/actions", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return { ok: true, data: describeActions() };
  });

  // Одна ручка на все действия: агенту достаточно знать имя и параметры,
  // а маршрутизация между Graph и браузером остаётся внутренним делом сервиса.
  app.post<{ Params: { action: string } }>("/actions/:action", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const name = request.params.action;
    if (!isActionName(name)) {
      reply.code(404);
      return toEnvelope(
        new ActionError("INVALID_INPUT", `Неизвестное действие «${name}». Список: GET /actions`, { retryable: false }),
      );
    }

    try {
      const data = await execute(name, request.body);
      return { ok: true, data };
    } catch (err) {
      const envelope = toEnvelope(err);
      reply.code(httpStatusFor(envelope.error.code));
      if (envelope.error.retry_after !== undefined) {
        reply.header("retry-after", String(envelope.error.retry_after));
      }
      return envelope;
    }
  });

  // Удобный синоним самого частого действия.
  app.post("/post", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return { ok: true, data: await execute("publish_post", request.body) };
    } catch (err) {
      const envelope = toEnvelope(err);
      reply.code(httpStatusFor(envelope.error.code));
      return envelope;
    }
  });

  registerBrowserRoutes(app);
  registerOAuthRoutes(app);
  return app;
}

/** Управление браузерным профилем: нужно, чтобы человек мог войти руками через noVNC. */
function registerBrowserRoutes(app: FastifyInstance): void {
  app.post<{ Body?: { minutes?: number } }>("/browser/suspend", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const minutes = Math.min(Math.max(request.body?.minutes ?? 15, 1), 120);
    return { ok: true, data: await session.suspend(minutes) };
  });

  app.post("/browser/resume", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return { ok: true, data: await session.resume() };
  });

  app.post("/browser/login-check", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return { ok: true, data: await execute("check_login", {}) };
    } catch (err) {
      const envelope = toEnvelope(err);
      reply.code(httpStatusFor(envelope.error.code));
      return envelope;
    }
  });
}

/**
 * OAuth. Старт требует bearer-токена и выдаёт одноразовый state; callback
 * открыт (иначе Threads не сможет вернуть браузер) и проверяет этот state.
 */
function registerOAuthRoutes(app: FastifyInstance): void {
  app.get("/oauth/start", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    reply.redirect(buildAuthorizationUrl(OAUTH_SCOPES));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/oauth/callback",
    async (request, reply) => {
      const { code, state, error, error_description: description } = request.query;

      if (error) {
        reply.code(400);
        return `Threads отказал в доступе: ${description ?? error}`;
      }
      if (!code) {
        reply.code(400);
        return "В запросе нет параметра code";
      }

      // Ручка обязана быть открытой — Threads редиректит сюда браузер без
      // заголовков. Единственное, что отличает наш запрос от чужого, — state,
      // выданный на /oauth/start. Без этой проверки посторонний мог бы прислать
      // свой код и заменить аккаунт, от имени которого работает сервис.
      try {
        verifyOAuthState(state);
      } catch (err) {
        request.log.warn(`Отклонён OAuth callback с чужим state (ip=${request.ip})`);
        reply.code(400).type("text/plain; charset=utf-8");
        return err instanceof Error ? err.message : "Некорректный state";
      }

      try {
        const shortLived = await exchangeCodeForShortLivedToken(code.replace(/#_$/, ""));
        const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
        const stored = persistLongLivedToken(longLived, shortLived.userId);

        reply.type("text/plain; charset=utf-8");
        return (
          `Готово. Токен сохранён для user_id=${stored.userId}.\n` +
          `Действует до ${new Date(stored.expiresAt * 1000).toISOString()} и продлевается автоматически.`
        );
      } catch (err) {
        reply.code(502).type("text/plain; charset=utf-8");
        return `Не удалось обменять код на токен: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );
}

export { actions };
