/**
 * Замер одного сбора карточек: куда именно уходит время.
 *
 * Поставлен по следам вечернего прогона 2026-08-20, где одинаковая работа —
 * набрать сотню постов — заняла то 42 секунды, то 848. По логам сервиса видно
 * только полное время запроса, а внутри него три подозреваемых: ожидание
 * пропавших карточек (у каждого обращения к карточке потолок CARD_TIMEOUT_MS),
 * повторный обход уже разобранных контейнеров на каждом круге скролла и
 * ленивая подгрузка на стороне Threads. Различить их можно только цифрами.
 *
 * Замер ничего не меняет в поведении: он только считает и в конце сбора пишет
 * одну строку в лог.
 *
 * Состояние модульное, а не переданное параметром, потому что браузерные
 * задачи идут строго по одной (SerialQueue) — двух сборов разом не бывает, а
 * протаскивать счётчик через десяток функций разбора карточки значило бы
 * переписать их все ради временной диагностики.
 */

type Round = {
  /** Сколько контейнеров поста было на странице в этом круге. */
  containers: number;
  /** Из них пропущено как уже разобранные. */
  skipped: number;
  /** Разобрано новых карточек. */
  parsed: number;
  /** Время на чтение href у всех контейнеров круга, включая пропускаемые. */
  hrefMs: number;
  /** Время на разбор новых карточек. */
  cardMs: number;
  /** Время в scrollDown — прокрутка плюс фиксированная пауза. */
  scrollMs: number;
};

type Probe = {
  label: string;
  limit: number;
  startedAt: number;
  rounds: Round[];
  /** Отказы обращений к карточке по шагам разбора: text, time, like, media… */
  fails: Record<string, number>;
  /** Времена разбора отдельных карточек — по ним видно хвост долгих. */
  cardTimes: number[];
};

let current: Probe | null = null;

const now = (): number => Date.now();

export function startProbe(label: string, limit: number): void {
  current = { label, limit, startedAt: now(), rounds: [], fails: {}, cardTimes: [] };
}

export function startRound(): Round {
  const round: Round = { containers: 0, skipped: 0, parsed: 0, hrefMs: 0, cardMs: 0, scrollMs: 0 };
  current?.rounds.push(round);
  return round;
}

/** Отказ на одном шаге разбора карточки: чаще всего это выбранный потолок ожидания. */
export function noteFail(step: string): void {
  if (!current) return;
  current.fails[step] = (current.fails[step] ?? 0) + 1;
}

export function noteCard(ms: number): void {
  current?.cardTimes.push(ms);
}

/** Замеряет функцию и отдаёт её результат вместе с потраченным временем. */
export async function measure<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = now();
  const value = await run();
  return [value, now() - started];
}

const sum = (values: readonly number[]): number => values.reduce((acc, value) => acc + value, 0);

/**
 * Итог сбора одной строкой. «Прочее» — это время внутри сбора, не попавшее ни
 * в один из замеров: навигация, ожидание отрисовки, всё, что делает Playwright
 * между нашими вызовами. Большое «прочее» означало бы, что подозреваемых надо
 * искать не там, где мы их ищем.
 */
export function finishProbe(collected: number): void {
  if (!current) return;
  const probe = current;
  current = null;

  const totalMs = now() - probe.startedAt;
  const hrefMs = sum(probe.rounds.map((round) => round.hrefMs));
  const cardMs = sum(probe.rounds.map((round) => round.cardMs));
  const scrollMs = sum(probe.rounds.map((round) => round.scrollMs));
  const slowCards = probe.cardTimes.filter((ms) => ms >= 1_800).length;

  console.log(
    JSON.stringify({
      level: 30,
      time: now(),
      msg: "замер сбора",
      probe: {
        label: probe.label,
        limit: probe.limit,
        collected,
        totalMs,
        rounds: probe.rounds.length,
        cards: probe.cardTimes.length,
        slowCards,
        maxCardMs: probe.cardTimes.length ? Math.max(...probe.cardTimes) : 0,
        hrefMs,
        cardMs,
        scrollMs,
        otherMs: totalMs - hrefMs - cardMs - scrollMs,
        fails: probe.fails,
        perRound: probe.rounds,
      },
    }),
  );
}
