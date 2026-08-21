import { describe, expect, it } from "vitest";
import {
  CHUNK,
  CHUNK_PAUSE,
  DISTANCE,
  LONG_PAUSE,
  LONG_PAUSE_CHANCE,
  MOUSE_CHANCE,
  PAUSE,
  planMouse,
  planPause,
  planScroll,
} from "./scroll.js";

/** Источник «случайности» с наперёд заданными значениями — план становится проверяемым. */
function rngOf(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

const within = (value: number, [min, max]: readonly [number, number]) => value >= min && value <= max;

describe("план прокрутки", () => {
  it("шлёт серию мелких щелчков, а не одну ступеньку", () => {
    const plan = planScroll(rngOf([0.5]));

    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
    // Последний щелчок законно короче: это остаток расстояния и хвост
    // инерции, см. отдельную проверку ниже. Остальные — обычный щелчок колеса.
    for (const chunk of plan.chunks.slice(0, -1)) {
      expect(within(chunk, CHUNK)).toBe(true);
    }
    expect(plan.chunks.at(-1)!).toBeLessThanOrEqual(CHUNK[1]);
    expect(plan.chunks.at(-1)!).toBeGreaterThan(0);
  });

  // Пройденное за круг расстояние должно оставаться в тех же пределах, что и
  // раньше: сбор рассчитывает, что круг скролла приносит новые карточки, а
  // слишком короткий круг упёрся бы в счётчик пустых кругов и оборвал сбор.
  it("за круг проходит примерно прежнее расстояние", () => {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
      const plan = planScroll(rngOf([value]));
      const total = plan.chunks.reduce((sum, chunk) => sum + chunk, 0);
      expect(total).toBeGreaterThanOrEqual(DISTANCE[0] - CHUNK[1]);
      expect(total).toBeLessThanOrEqual(DISTANCE[1] + CHUNK[1]);
    }
  });

  it("последний щелчок короче предыдущего — хвост инерции", () => {
    const plan = planScroll(rngOf([0.5]));
    const last = plan.chunks.at(-1)!;
    const beforeLast = plan.chunks.at(-2)!;

    expect(last).toBeLessThan(beforeLast);
  });

  it("паузы между щелчками короткие и разные, а не ровные", () => {
    const plan = planScroll(rngOf([0.1, 0.9, 0.3, 0.7, 0.5]));

    expect(plan.chunkPauses).toHaveLength(plan.chunks.length);
    for (const pause of plan.chunkPauses) {
      expect(within(pause, CHUNK_PAUSE)).toBe(true);
    }
    expect(new Set(plan.chunkPauses).size).toBeGreaterThan(1);
  });

  it("собирает круг целиком: щелчки, паузы и решение про курсор", () => {
    const plan = planScroll(rngOf([0.5]));

    expect(plan.chunks.length).toBe(plan.chunkPauses.length);
    expect(plan.pauseMs).toBeGreaterThan(0);
  });
});

describe("пауза после серии", () => {
  it("обычно в спокойном диапазоне", () => {
    expect(within(planPause(rngOf([0.9, 0.5])), PAUSE)).toBe(true);
  });

  // Изредка человек засматривается: без таких выбросов распределение пауз
  // остаётся слишком ровным, даже если сами паузы случайные.
  it("изредка залипает надолго", () => {
    expect(within(planPause(rngOf([LONG_PAUSE_CHANCE / 2, 0.5])), LONG_PAUSE)).toBe(true);
  });

  it("миллисекундная, а не округлённая до секунд", () => {
    const pause = planPause(rngOf([0.9, 0.123_456]));
    expect(Number.isInteger(pause)).toBe(true);
    expect(pause % 100).not.toBe(0);
  });
});

describe("движение курсора", () => {
  it("иногда двигаем, но не каждый круг", () => {
    expect(planMouse(rngOf([MOUSE_CHANCE / 2, 0.5, 0.5]))).not.toBeNull();
    expect(planMouse(rngOf([0.999]))).toBeNull();
  });

  it("курсор остаётся внутри окна", () => {
    for (const value of [0, 0.5, 0.999]) {
      const point = planMouse(rngOf([MOUSE_CHANCE / 2, value]))!;
      expect(within(point.x, [0, 1_280])).toBe(true);
      expect(within(point.y, [0, 900])).toBe(true);
    }
  });
});
