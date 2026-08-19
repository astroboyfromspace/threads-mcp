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
    // Регэксп нашёл что-то похожее на число, но Number() его не разобрал —
    // выдуманный ноль здесь хуже пустого значения: он молча соврёт в датасет.
    return Number.isFinite(value) ? value : null;
  }

  // С суффиксом тот же знак — уже десятичный: «1,2 тыс.» — это 1200.
  const value = Number(digits.replace(/[ \s]/g, "").replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * scale) : null;
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

/** Отрисованный прямоугольник элемента — то, что реально видно на странице. */
export type MediaRect = { width: number; height: number };

/**
 * Считает картинки и видео карточки по их отрисованным прямоугольникам.
 *
 * Threads рисует у видео два наложенных элемента одного размера: сам
 * <video> и <img> с кадром-превью поверх него. Без исключения превью каждый
 * ролик считался бы ещё и картинкой — mediaCount задваивался, а пост с одним
 * роликом приезжал как media "mixed" вместо "video" (на карусели то же самое
 * умножало mediaCount на пары «кадр + ролик» на каждом слайде). Правило:
 * картинка, чей прямоугольник совпадает с прямоугольником какого-либо видео
 * из той же карточки, — превью, и в счёт не идёт. Сравниваем с допуском в
 * пару пикселей, а не побайтово: вёрстка отдаёт дробные значения.
 *
 * images со значением null — картинка, у которой не удалось получить размер
 * (например, ещё не отрисованная лениво картинка). Если размера не удалось
 * получить ни у одной найденной картинки, честный ответ — null, а не
 * выдуманный ноль: см. классификацию этого случая в classifyMedia.
 */
export function countMedia(
  images: ReadonlyArray<MediaRect | null>,
  videos: readonly MediaRect[],
  { minWidth = 100, tolerance = 2 }: { minWidth?: number; tolerance?: number } = {},
): { images: number; videos: number } | null {
  // Картинок-кандидатов нет вовсе — это законный «медиа нет» (или «только
  // видео»), а не «не смогли определить»: рисовать нечего, а не не удалось
  // посчитать.
  if (images.length === 0) return { images: 0, videos: videos.length };

  const withSize = images.filter((img): img is MediaRect => img !== null);
  if (withSize.length === 0) return null;

  const isVideoPreview = (img: MediaRect) =>
    videos.some(
      (video) => Math.abs(img.width - video.width) <= tolerance && Math.abs(img.height - video.height) <= tolerance,
    );

  const own = withSize.filter((img) => !isVideoPreview(img) && img.width >= minWidth);
  return { images: own.length, videos: videos.length };
}

export type Lang = "ru" | "en" | "other";

/**
 * Хвост-подпись кнопки перевода, которую Threads приклеивает к тексту поста
 * не на английском: «Тут текст поста<NBSP><NBSP>Translate». Интерфейс
 * бывает и русским — тогда хвост «…Перевести».
 *
 * Перед словом — ровно неразрывные пробелы ( ), а не обычные: это и
 * отличает служебный хвост от законного «...Translate» в конце обычного
 * английского предложения, набранного как текст поста, а не приклеенного
 * Threads. Обычный пробел трогать нельзя.
 */
const TRANSLATE_TAIL = / +(Translate|Перевести)$/;

/** Отрезает хвост-подпись кнопки перевода, если он есть. См. TRANSLATE_TAIL. */
export function stripTranslateTail(text: string): string {
  return text.replace(TRANSLATE_TAIL, "");
}

/**
 * Грубо определяет язык текста поста по алфавиту букв — без лингвистики и
 * внешних словарей: делить датасет собранных по английским частотным словам
 * постов на «свои» и «чужие» с точностью до языковой модели тут не нужно и
 * не заказано, достаточно честной метки.
 *
 * Считаем три вида букв: кириллица, латиница, всё остальное (хинди, арабица,
 * иероглифы и так далее). Цифры, эмодзи, пунктуация и пробелы не считаются
 * вовсе — они ничего не говорят о языке текста.
 *
 * Порог в 20% для «прочих» и для кириллицы — не педантизм: в живой выдаче
 * постоянно попадаются посты с приклеенными английскими хештегами в хвосте
 * (русский пост с #threads #video в конце, хинди-пост с латинскими тегами).
 * Без порога пара латинских букв в хвосте перекрасила бы всю метку в "en"
 * или "other" и соврала бы про язык самого поста.
 */
export function detectLang(text: string): Lang | null {
  let cyrillic = 0;
  let latin = 0;
  let other = 0;

  for (const char of text) {
    if (/[а-яё]/i.test(char)) cyrillic += 1;
    else if (/[a-z]/i.test(char)) latin += 1;
    else if (/\p{L}/u.test(char)) other += 1;
  }

  const total = cyrillic + latin + other;
  if (total === 0) return null;

  if (other / total >= 0.2) return "other";
  if (cyrillic / total >= 0.2) return "ru";
  if (latin > 0) return "en";
  return null;
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
  lang: Lang | null;
};

export function authorFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /\/@([^/]+)\/post\//.exec(url);
  return match?.[1] ?? null;
}

/**
 * Превращает сырьё в карточку.
 *
 * null — только если в контейнере нет вообще ничего опознаваемого: ни
 * текста, ни ссылки на пост. Пост без текста — законный случай (например,
 * видео с темой, но без подписи), и терять такую карточку целиком нельзя.
 */
export function buildCard(raw: RawCard): PostCard | null {
  // Хвост-подпись кнопки перевода отрезаем до определения языка: иначе
  // приклеенное Threads слово "Translate"/"Перевести" само попадёт в подсчёт
  // букв и будет тянуть метку в сторону английского.
  const text = stripTranslateTail(raw.text.trim());
  if (!text && !raw.href) return null;

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
    lang: detectLang(text),
  };
}
