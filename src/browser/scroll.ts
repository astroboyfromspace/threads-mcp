/**
 * Форма одного круга прокрутки.
 *
 * Прежде круг был одним событием колеса ровно на 2000 пикселей и ровно через
 * 1200 миллисекунд после предыдущего. Со стороны страницы это не похоже ни на
 * одно устройство ввода: настоящее колесо шлёт серию мелких дельт со щелчка,
 * трекпад — десятки событий с ускорением и хвостом инерции, и ни там, ни там
 * интервалы не совпадают до миллисекунды.
 *
 * Здесь только план — числа. Выполняет его scrollDown в actions.ts, а
 * отдельно план живёт затем, что случайность иначе не проверить тестами:
 * источник случайных чисел передаётся параметром и в тестах подменяется.
 *
 * Гарантий это не даёт никаких и дать не может — только убирает самые грубые
 * следы. Главный риск блокировки — объём и датацентровый адрес, а не форма
 * прокрутки.
 */

/** Сколько пикселей проходим за круг. Прежние 2000 лежат внутри этого разброса. */
export const DISTANCE: readonly [number, number] = [1_400, 2_600];

/** Один щелчок колеса. У настоящей мыши это около сотни пикселей. */
export const CHUNK: readonly [number, number] = [90, 170];

/** Пауза между щелчками внутри серии. */
export const CHUNK_PAUSE: readonly [number, number] = [25, 90];

/** Пауза после серии — ожидание подгрузки. Втрое длиннее прежней: скорость нам не нужна. */
export const PAUSE: readonly [number, number] = [1_800, 3_500];

/** Изредка человек засматривается на пост. */
export const LONG_PAUSE: readonly [number, number] = [6_000, 15_000];
export const LONG_PAUSE_CHANCE = 0.15;

/** Как часто за круг двигаем курсор. Сбор, не двинувший его ни разу за сотню постов, — сам по себе примета. */
export const MOUSE_CHANCE = 0.35;

/** Окно браузера из session.ts: курсор не должен уезжать за его пределы. */
const VIEWPORT = { width: 1_280, height: 900 };

export type ScrollPlan = {
  /** Дельты щелчков колеса, по порядку. */
  chunks: number[];
  /** Пауза после каждого щелчка; длина совпадает с chunks. */
  chunkPauses: number[];
  /** Пауза после всей серии. */
  pauseMs: number;
  /** Куда двинуть курсор, или null — в этом круге не двигаем. */
  mouse: { x: number; y: number } | null;
};

type Rng = () => number;

/** Целое из отрезка включительно. Шаг — миллисекунда или пиксель, без округления до круглых значений. */
function between(rng: Rng, [min, max]: readonly [number, number]): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function planScroll(rng: Rng = Math.random): ScrollPlan {
  const distance = between(rng, DISTANCE);

  const chunks: number[] = [];
  let left = distance;
  while (left > 0) {
    const chunk = Math.min(between(rng, CHUNK), left);
    chunks.push(chunk);
    left -= chunk;
  }

  // Хвост инерции: последний щелчок короче предыдущего. У настоящего колеса
  // серия затухает, а не обрывается на полной дельте.
  if (chunks.length >= 2) {
    chunks[chunks.length - 1] = Math.max(1, Math.floor(chunks[chunks.length - 1]! / 2));
  }

  const chunkPauses = chunks.map(() => between(rng, CHUNK_PAUSE));

  return { chunks, chunkPauses, pauseMs: planPause(rng), mouse: planMouse(rng) };
}

/**
 * Пауза после серии щелчков. Отдельной функцией — чтобы редкая ветка
 * «засмотрелся» проверялась тестом прицельно: внутри planScroll до неё
 * добирается непредсказуемое число обращений к источнику случайности.
 */
export function planPause(rng: Rng = Math.random): number {
  return between(rng, rng() < LONG_PAUSE_CHANCE ? LONG_PAUSE : PAUSE);
}

/** Куда двинуть курсор в этом круге; null — не двигаем. Отдельно по той же причине, что и planPause. */
export function planMouse(rng: Rng = Math.random): { x: number; y: number } | null {
  if (rng() >= MOUSE_CHANCE) return null;
  return { x: between(rng, [40, VIEWPORT.width - 40]), y: between(rng, [40, VIEWPORT.height - 40]) };
}
