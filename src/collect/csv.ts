import type { CollectedPost } from "./db.js";

const HEADER = [
  "url",
  "author",
  "published_at",
  "likes",
  "replies",
  "reposts",
  "media",
  "media_count",
  "lang",
  "source",
  "found_by",
  "text",
];

/** Строки — всегда в кавычках, числа — как есть, пустое — пустым полем. */
function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Собирает датасет в CSV.
 *
 * Текст поста идёт последним столбцом намеренно: он самый длинный и содержит
 * переводы строк, поэтому файл читается глазами куда легче, когда всё
 * табличное стоит слева от него.
 */
export function toCsv(posts: CollectedPost[]): string {
  const rows = posts.map((post) =>
    [
      cell(post.url),
      cell(post.author),
      cell(post.publishedAt),
      cell(post.likes),
      cell(post.replies),
      cell(post.reposts),
      cell(post.media),
      cell(post.mediaCount),
      cell(post.lang),
      cell(post.source),
      cell(post.foundBy),
      cell(post.text),
    ].join(","),
  );

  return [HEADER.join(","), ...rows].join("\n") + "\n";
}
