import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Lang, MediaKind } from "../browser/cards.js";

export type CollectedPost = {
  url: string;
  author: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  media: MediaKind | null;
  mediaCount: number | null;
  lang: Lang | null;
  source: "search" | "feed";
  foundBy: string | null;
};

export type CollectDb = {
  syncQueries(words: string[]): void;
  nextQueries(count: number): string[];
  insertPosts(posts: CollectedPost[], at: number): number;
  recordRun(word: string, result: { newPosts?: number; error?: string }, at: number): void;
  recordError(word: string, error: string, at: number): void;
  lastError(word: string): string | null;
  /** Сколько раз слово честно отработало заход (recordRun). Нужен тестам: recordError не должен это трогать. */
  runs(word: string): number;
  totalPosts(): number;
  allPosts(): CollectedPost[];
  close(): void;
};

/**
 * База сборщика — отдельный файл, не сервисный state.db.
 *
 * Там живут токен и журнал действий, и датасету рядом с ними делать нечего:
 * отдельный файл копируется, архивируется и удаляется целиком, не задевая
 * работу сервиса.
 */
export function openCollectDb(path: string): CollectDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS post (
      url          TEXT PRIMARY KEY,
      author       TEXT,
      text         TEXT NOT NULL,
      published_at TEXT,
      likes        INTEGER,
      replies      INTEGER,
      reposts      INTEGER,
      media        TEXT,
      media_count  INTEGER,
      lang         TEXT,
      source       TEXT NOT NULL,
      found_by     TEXT,
      collected_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query (
      text        TEXT PRIMARY KEY,
      last_run_at INTEGER,
      runs        INTEGER NOT NULL DEFAULT 0,
      last_new    INTEGER,
      last_error  TEXT
    );
  `);

  // CREATE TABLE IF NOT EXISTS новую колонку в уже существующей на диске базе
  // не добавит — владелец мог собирать датасет до появления lang. Дочиняем
  // схему сами: смотрим через PRAGMA table_info, есть ли колонка, и добавляем
  // её через ALTER TABLE, если нет. На новой базе колонка уже создана выше, и
  // это просто ничего не делает.
  const columns = db.prepare(`PRAGMA table_info(post)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "lang")) {
    db.exec(`ALTER TABLE post ADD COLUMN lang TEXT`);
  }

  const insertPost = db.prepare(`
    INSERT OR IGNORE INTO post
      (url, author, text, published_at, likes, replies, reposts, media, media_count, lang, source, found_by, collected_at)
    VALUES
      (@url, @author, @text, @publishedAt, @likes, @replies, @reposts, @media, @mediaCount, @lang, @source, @foundBy, @collectedAt)
  `);

  const insertMany = db.transaction((posts: CollectedPost[], at: number) => {
    let added = 0;
    for (const post of posts) {
      added += insertPost.run({ ...post, collectedAt: at }).changes;
    }
    return added;
  });

  return {
    syncQueries(words) {
      const insert = db.prepare(`INSERT OR IGNORE INTO query (text) VALUES (?)`);
      db.transaction(() => {
        for (const word of words) insert.run(word);
      })();
    },

    // Слова, которых давно не касались, идут первыми: повторный заход по
    // свежеискавшемуся слову принесёт ту же выдачу, и дедуп её выбросит.
    nextQueries(count) {
      const rows = db
        .prepare(
          `SELECT text FROM query
           ORDER BY last_run_at IS NOT NULL, last_run_at ASC, text ASC
           LIMIT ?`,
        )
        .all(count) as Array<{ text: string }>;
      return rows.map((row) => row.text);
    },

    insertPosts(posts, at) {
      if (posts.length === 0) return 0;
      return insertMany(posts, at);
    },

    recordRun(word, result, at) {
      db.prepare(
        `UPDATE query
            SET last_run_at = ?, runs = runs + 1, last_new = ?, last_error = ?
          WHERE text = ?`,
      ).run(at, result.newPosts ?? null, result.error ?? null, word);
    },

    // Ошибка сама по себе не значит, что слово честно отработано: не трогаем
    // last_run_at и runs, иначе слово уедет в конец очереди ротации, ничего не
    // собрав, — а неверный токен одним заходом сожжёт ротацию целиком.
    recordError(word, error) {
      db.prepare(`UPDATE query SET last_error = ? WHERE text = ?`).run(error, word);
    },

    lastError(word) {
      const row = db.prepare(`SELECT last_error FROM query WHERE text = ?`).get(word) as
        | { last_error: string | null }
        | undefined;
      return row?.last_error ?? null;
    },

    runs(word) {
      const row = db.prepare(`SELECT runs FROM query WHERE text = ?`).get(word) as { runs: number } | undefined;
      return row?.runs ?? 0;
    },

    totalPosts() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM post`).get() as { n: number };
      return row.n;
    },

    allPosts() {
      const rows = db.prepare(`SELECT * FROM post ORDER BY collected_at, url`).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        url: row.url as string,
        author: row.author as string | null,
        text: row.text as string,
        publishedAt: row.published_at as string | null,
        likes: row.likes as number | null,
        replies: row.replies as number | null,
        reposts: row.reposts as number | null,
        media: row.media as MediaKind | null,
        mediaCount: row.media_count as number | null,
        lang: row.lang as Lang | null,
        source: row.source as "search" | "feed",
        foundBy: row.found_by as string | null,
      }));
    },

    close() {
      db.close();
    },
  };
}
