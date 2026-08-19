/**
 * Разбор карточки поста — всё, что не требует живой страницы.
 *
 * Вынесено из actions.ts намеренно: браузерные действия тестами не покрываются,
 * а вот превращение «1,2 тыс.» в 1200 покрыть обязано — ошибка здесь тихо
 * испортит весь датасет и обнаружится, когда по нему уже посчитают статистику.
 */

import { URLS } from "./selectors.js";

export type MediaKind = "none" | "image" | "video" | "mixed";

const SCALES: Array<{ pattern: RegExp; factor: number }> = [
  { pattern: /^(k|тыс\.?)/i, factor: 1_000 },
  { pattern: /^(m|млн)/i, factor: 1_000_000 },
  { pattern: /^(b|млрд)/i, factor: 1_000_000_000 },
];

/**
 * Достаёт число из подписи доступности: «Unlike 3» → 3, «1.2K» → 1200.
 *
 * Подпись без числа — ноль: у поста без лайков Threads не рисует счётчик рядом
 * с кнопкой. Отсутствие самой подписи — null: кнопки не нашли, и это другое.
 */
export function parseCount(label: string | null): number | null {
  if (!label || !label.trim()) return null;

  const match = /(\d[\d., \s]*)\s*(k|m|b|тыс\.?|млн|млрд)?/i.exec(label);
  if (!match) return 0;

  const digits = match[1]!.trim();
  const suffix = match[2];
  const scale = suffix ? SCALES.find((item) => item.pattern.test(suffix))?.factor ?? 1 : 1;

  if (scale === 1) {
    // Без суффикса точка, запятая и пробел разделяют тысячи: «1,234» — это 1234.
    const value = Number(digits.replace(/[., \s]/g, ""));
    return Number.isFinite(value) ? value : 0;
  }

  // С суффиксом тот же знак — уже десятичный: «1,2 тыс.» — это 1200.
  const value = Number(digits.replace(/[ \s]/g, "").replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * scale) : 0;
}

/** Сводит счёт картинок и видео к одному признаку. null на входе — «определить не смогли». */
export function classifyMedia(counts: { images: number; videos: number } | null): {
  media: MediaKind | null;
  mediaCount: number | null;
} {
  if (!counts) return { media: null, mediaCount: null };

  const { images, videos } = counts;
  const mediaCount = images + videos;

  if (images > 0 && videos > 0) return { media: "mixed", mediaCount };
  if (videos > 0) return { media: "video", mediaCount };
  if (images > 0) return { media: "image", mediaCount };
  return { media: "none", mediaCount: 0 };
}

/** Сырьё, снятое со страницы: строки как есть, без интерпретации. */
export type RawCard = {
  href: string | null;
  text: string;
  datetime: string | null;
  likeLabel: string | null;
  replyLabel: string | null;
  repostLabel: string | null;
  media: { images: number; videos: number } | null;
};

export type PostCard = {
  author: string | null;
  url: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  media: MediaKind | null;
  mediaCount: number | null;
};

export function authorFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /\/@([^/]+)\/post\//.exec(url);
  return match?.[1] ?? null;
}

/** Превращает сырьё в карточку. null — если в контейнере не было текста. */
export function buildCard(raw: RawCard): PostCard | null {
  const text = raw.text.trim();
  if (!text) return null;

  const url = raw.href ? new URL(raw.href, URLS.home).toString() : null;
  const { media, mediaCount } = classifyMedia(raw.media);

  return {
    author: authorFromUrl(url),
    url,
    text,
    publishedAt: raw.datetime,
    likes: parseCount(raw.likeLabel),
    replies: parseCount(raw.replyLabel),
    reposts: parseCount(raw.repostLabel),
    media,
    mediaCount,
  };
}
