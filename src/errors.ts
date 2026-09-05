export type ErrorCode =
  /** Браузерная сессия разлогинена — нужен ручной вход через noVNC. */
  | "NEEDS_LOGIN"
  /** Упёрлись в лимит: наш собственный или отданный Threads. */
  | "RATE_LIMITED"
  /** Ошибка на стороне Threads: Graph API вернул отказ или сайт показал свою заглушку вместо содержимого. */
  | "UPSTREAM"
  /** Браузер не нашёл нужный элемент — скорее всего, Threads изменил вёрстку. */
  | "SELECTOR_MISS"
  /** Некорректные входные данные. */
  | "INVALID_INPUT"
  /** Всё остальное. */
  | "INTERNAL";

export class ActionError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ActionError";
    this.code = code;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === "RATE_LIMITED" || code === "UPSTREAM";
}

/** HTTP-статус, который стоит вернуть клиенту для данного класса ошибки. */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "RATE_LIMITED":
      return 429;
    case "NEEDS_LOGIN":
      return 503;
    case "UPSTREAM":
      return 502;
    case "SELECTOR_MISS":
      return 500;
    case "INTERNAL":
      return 500;
  }
}

export type ErrorEnvelope = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after?: number;
    details?: unknown;
  };
};

export type Envelope<T> = { ok: true; data: T } | ErrorEnvelope;

export function toEnvelope(err: unknown): ErrorEnvelope {
  const actionErr =
    err instanceof ActionError
      ? err
      : new ActionError("INTERNAL", err instanceof Error ? err.message : String(err), { cause: err });

  return {
    ok: false,
    error: {
      code: actionErr.code,
      message: actionErr.message,
      retryable: actionErr.retryable,
      ...(actionErr.retryAfterSeconds !== undefined ? { retry_after: actionErr.retryAfterSeconds } : {}),
      ...(actionErr.details !== undefined ? { details: actionErr.details } : {}),
    },
  };
}
