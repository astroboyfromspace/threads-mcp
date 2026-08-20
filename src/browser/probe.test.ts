import { afterEach, describe, expect, it, vi } from "vitest";
import { finishProbe, measure, noteCard, noteFail, startProbe, startRound } from "./probe.js";

/** Достаёт из console.log единственную строку замера и разбирает её обратно в объект. */
function captureProbe(run: () => void): Record<string, any> | null {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    run();
    const line = spy.mock.calls.at(-1)?.[0];
    return typeof line === "string" ? JSON.parse(line).probe : null;
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("замер сбора", () => {
  it("складывает время кругов и выводит остаток в «прочее»", () => {
    startProbe("лента", 100);
    const round = startRound();
    round.containers = 12;
    round.skipped = 4;
    round.parsed = 8;
    round.hrefMs = 100;
    round.cardMs = 900;
    round.scrollMs = 1_200;
    noteCard(200);
    noteCard(2_000);

    const probe = captureProbe(() => finishProbe(8));

    expect(probe).toMatchObject({ label: "лента", collected: 8, rounds: 1, cards: 2 });
    expect(probe!.hrefMs + probe!.cardMs + probe!.scrollMs + probe!.otherMs).toBe(probe!.totalMs);
    // Карточка на две секунды — это упёршийся потолок ожидания, ради счёта
    // таких карточек замер и ставился.
    expect(probe!.slowCards).toBe(1);
    expect(probe!.maxCardMs).toBe(2_000);
  });

  it("считает отказы по шагам разбора", () => {
    startProbe("поиск", 50);
    startRound();
    noteFail("text");
    noteFail("media");
    noteFail("media");

    const probe = captureProbe(() => finishProbe(0));

    expect(probe!.fails).toEqual({ text: 1, media: 2 });
  });

  // Счётчик модульный, и незакрытый замер не должен подмешиваться в следующий:
  // иначе цифры прошлого сбора пришли бы в лог как цифры текущего.
  it("новый сбор начинает счёт заново", () => {
    startProbe("поиск", 50);
    startRound();
    noteFail("text");
    noteCard(500);

    startProbe("лента", 100);
    startRound();
    const probe = captureProbe(() => finishProbe(0));

    expect(probe!.fails).toEqual({});
    expect(probe!.cards).toBe(0);
  });

  it("measure отдаёт результат и потраченное время", async () => {
    const [value, ms] = await measure(async () => "готово");
    expect(value).toBe("готово");
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});
