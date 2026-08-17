import Database from "better-sqlite3";
import { config, ensureDirs } from "./config.js";

export type StoredToken = {
  accessToken: string;
  userId: string;
  expiresAt: number; // unix-секунды
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDirs();
  db = new Database(config.paths.database);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS token (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT    NOT NULL,
      user_id      TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      action     TEXT    NOT NULL,
      driver     TEXT    NOT NULL,
      ok         INTEGER NOT NULL,
      input      TEXT,
      result     TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS action_log_action_time
      ON action_log (action, created_at);
  `);
}

export function saveToken(token: StoredToken): void {
  getDb()
    .prepare(
      `INSERT INTO token (id, access_token, user_id, expires_at)
       VALUES (1, @accessToken, @userId, @expiresAt)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         user_id      = excluded.user_id,
         expires_at   = excluded.expires_at`,
    )
    .run(token);
}

export function loadToken(): StoredToken | null {
  const row = getDb()
    .prepare<[], { access_token: string; user_id: string; expires_at: number }>(
      `SELECT access_token, user_id, expires_at FROM token WHERE id = 1`,
    )
    .get();
  if (!row) return null;
  return { accessToken: row.access_token, userId: row.user_id, expiresAt: row.expires_at };
}

export type LogEntry = {
  action: string;
  driver: "graph" | "browser";
  ok: boolean;
  input?: unknown;
  result?: unknown;
  errorCode?: string;
};

export function logAction(entry: LogEntry): void {
  getDb()
    .prepare(
      `INSERT INTO action_log (action, driver, ok, input, result, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.action,
      entry.driver,
      entry.ok ? 1 : 0,
      entry.input === undefined ? null : JSON.stringify(entry.input),
      entry.result === undefined ? null : JSON.stringify(entry.result),
      entry.errorCode ?? null,
      Math.floor(Date.now() / 1000),
    );
}

/** Сколько раз действие успешно выполнялось за последние `windowSeconds`. */
export function countRecentSuccesses(action: string, windowSeconds: number): number {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = getDb()
    .prepare<[string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM action_log
       WHERE action = ? AND ok = 1 AND created_at >= ?`,
    )
    .get(action, since);
  return row?.n ?? 0;
}
