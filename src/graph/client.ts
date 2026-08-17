import { config } from "../config.js";
import { ActionError } from "../errors.js";

const API_VERSION = "v1.0";

type GraphErrorBody = {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
};

/**
 * Тонкая обёртка над graph.threads.net. Знает только про транспорт и ошибки;
 * что именно вызывать — решает уровень выше.
 */
export class GraphClient {
  constructor(private readonly accessToken: string) {}

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.request<T>("GET", url);
  }

  async post<T>(path: string, body: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = this.buildUrl(path, {});
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) form.set(key, String(value));
    }
    form.set("access_token", this.accessToken);
    return this.request<T>("POST", url, form);
  }

  async delete<T>(path: string): Promise<T> {
    const url = this.buildUrl(path, {});
    return this.request<T>("DELETE", url);
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): URL {
    const url = new URL(`${config.threads.apiBase}/${API_VERSION}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("access_token", this.accessToken);
    return url;
  }

  private async request<T>(method: string, url: URL, body?: URLSearchParams): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
      });
    } catch (cause) {
      throw new ActionError("UPSTREAM", `Не удалось достучаться до Threads API: ${String(cause)}`, {
        retryable: true,
        cause,
      });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ActionError("UPSTREAM", `Threads API вернул не-JSON (HTTP ${response.status})`, {
        details: text.slice(0, 500),
      });
    }

    if (!response.ok) throw graphError(response.status, parsed as GraphErrorBody);
    return parsed as T;
  }
}

function graphError(status: number, body: GraphErrorBody): ActionError {
  const message = body.error?.message ?? `Threads API вернул HTTP ${status}`;
  const code = body.error?.code;

  // 4 — общий rate limit приложения, 32/613 — лимиты вызовов.
  if (status === 429 || code === 4 || code === 32 || code === 613) {
    return new ActionError("RATE_LIMITED", message, { retryable: true, details: body.error });
  }
  // 190 — токен невалиден или отозван. Ретраить бессмысленно, нужен новый OAuth.
  if (code === 190) {
    return new ActionError("UPSTREAM", `Токен Threads недействителен: ${message}. Пройди OAuth заново: npm run auth`, {
      retryable: false,
      details: body.error,
    });
  }
  return new ActionError("UPSTREAM", message, {
    retryable: status >= 500,
    details: body.error,
  });
}
