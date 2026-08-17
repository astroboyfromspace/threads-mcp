import { config } from "../config.js";
import { loadToken, saveToken, type StoredToken } from "../db.js";
import { ActionError } from "../errors.js";
import { GraphClient } from "./client.js";

const REFRESH_WHEN_LESS_THAN_DAYS = 10;
const DAY_SECONDS = 86_400;

type TokenResponse = { access_token: string; token_type: string; expires_in: number };

/** Меняет короткоживущий код авторизации на короткоживущий токен. */
export async function exchangeCodeForShortLivedToken(code: string): Promise<{ accessToken: string; userId: string }> {
  const form = new URLSearchParams({
    client_id: config.threads.appId,
    client_secret: config.threads.appSecret,
    grant_type: "authorization_code",
    redirect_uri: config.threads.redirectUri,
    code,
  });

  const response = await fetch(`${config.threads.apiBase}/oauth/access_token`, {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const body = (await response.json()) as { access_token?: string; user_id?: string | number; error_message?: string };

  if (!response.ok || !body.access_token) {
    throw new ActionError("UPSTREAM", `Обмен кода на токен не удался: ${body.error_message ?? response.status}`);
  }
  return { accessToken: body.access_token, userId: String(body.user_id) };
}

/** Меняет короткоживущий токен на 60-дневный. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<TokenResponse> {
  const url = new URL(`${config.threads.apiBase}/access_token`);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", config.threads.appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url);
  const body = (await response.json()) as TokenResponse & { error?: { message?: string } };
  if (!response.ok || !body.access_token) {
    throw new ActionError("UPSTREAM", `Не удалось получить долгоживущий токен: ${body.error?.message ?? response.status}`);
  }
  return body;
}

/** Продлевает ещё не истёкший долгоживущий токен на следующие 60 дней. */
async function refreshLongLivedToken(token: string): Promise<TokenResponse> {
  const url = new URL(`${config.threads.apiBase}/refresh_access_token`);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", token);

  const response = await fetch(url);
  const body = (await response.json()) as TokenResponse & { error?: { message?: string } };
  if (!response.ok || !body.access_token) {
    throw new ActionError("UPSTREAM", `Не удалось обновить токен: ${body.error?.message ?? response.status}`);
  }
  return body;
}

export function persistLongLivedToken(token: TokenResponse, userId: string): StoredToken {
  const stored: StoredToken = {
    accessToken: token.access_token,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
  };
  saveToken(stored);
  return stored;
}

/**
 * Возвращает действующий токен, по пути продлевая его, если осталось меньше 10 дней.
 * Единственная точка, через которую Graph-действия получают токен.
 */
export async function getValidToken(): Promise<StoredToken> {
  const stored = loadToken();
  if (!stored) {
    throw new ActionError("UPSTREAM", "Токен Threads не настроен. Запусти: npm run auth", { retryable: false });
  }

  const now = Math.floor(Date.now() / 1000);
  if (stored.expiresAt <= now) {
    throw new ActionError(
      "UPSTREAM",
      "Токен Threads истёк и не может быть продлён автоматически. Пройди OAuth заново: npm run auth",
      { retryable: false },
    );
  }

  if (stored.expiresAt - now < REFRESH_WHEN_LESS_THAN_DAYS * DAY_SECONDS) {
    const refreshed = await refreshLongLivedToken(stored.accessToken);
    return persistLongLivedToken(refreshed, stored.userId);
  }

  return stored;
}

export async function getClient(): Promise<{ client: GraphClient; userId: string }> {
  const token = await getValidToken();
  return { client: new GraphClient(token.accessToken), userId: token.userId };
}

/** URL страницы, на которой владелец разрешает приложению доступ к своему аккаунту. */
export function buildAuthorizationUrl(scopes: readonly string[]): string {
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", config.threads.appId);
  url.searchParams.set("redirect_uri", config.threads.redirectUri);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("response_type", "code");
  return url.toString();
}
