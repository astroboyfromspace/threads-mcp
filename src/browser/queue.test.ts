import { describe, expect, it, vi } from "vitest";
import { SerialQueue } from "./queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialQueue", () => {
  it("выполняет задачи строго по одной", async () => {
    const queue = new SerialQueue(10);
    const events: string[] = [];
    const first = deferred<void>();

    const a = queue.run(async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = queue.run(async () => {
      events.push("b:start");
    });

    // Пока первая задача висит, вторая не должна была даже начаться.
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("упавшая задача не рвёт очередь", async () => {
    const queue = new SerialQueue(10);

    const failed = queue.run(async () => {
      throw new Error("bang");
    });
    const after = queue.run(async () => "жив");

    await expect(failed).rejects.toThrow("bang");
    await expect(after).resolves.toBe("жив");
  });

  it("отказывает с RATE_LIMITED при переполнении", async () => {
    const queue = new SerialQueue(2);
    const block = deferred<void>();

    const running = queue.run(() => block.promise);
    const waiting = queue.run(async () => undefined);

    await expect(queue.run(async () => undefined)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });

    block.resolve();
    await Promise.all([running, waiting]);

    // Место освободилось — снова принимает работу.
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });

  it("считает глубину очереди", async () => {
    const queue = new SerialQueue(5);
    const block = deferred<void>();

    const running = queue.run(() => block.promise);
    const queued = queue.run(async () => undefined);
    expect(queue.depth).toBe(2);

    block.resolve();
    await Promise.all([running, queued]);
    expect(queue.depth).toBe(0);
  });
});

describe("SerialQueue: потолок ожидания в очереди", () => {
  it("не дождавшаяся своей очереди задача отдаёт RATE_LIMITED, а не висит до таймаута клиента", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue(10, 45_000);
      const block = deferred<void>();
      const running = queue.run(() => block.promise);

      const waiting = queue.run(async () => "не должен выполниться");
      const rejected = expect(waiting).rejects.toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;

      block.resolve();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("отменённую по таймауту задачу не выполняет, когда очередь до неё дойдёт", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue(10, 45_000);
      const block = deferred<void>();
      const running = queue.run(() => block.promise);

      let ran = false;
      const waiting = queue.run(async () => {
        ran = true;
      });
      const rejected = expect(waiting).rejects.toMatchObject({ code: "RATE_LIMITED" });

      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;

      block.resolve();
      await running;
      await vi.advanceTimersByTimeAsync(0);

      // Место в очереди уже отдано клиенту как отказ: выполнить задачу после
      // этого значило бы сделать действие, о котором никто не узнает.
      expect(ran).toBe(false);
      expect(queue.depth).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("потолок считает ожидание, а не выполнение: начавшаяся задача идёт сколько нужно", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue(10, 45_000);
      const block = deferred<string>();
      const long = queue.run(() => block.promise);

      await vi.advanceTimersByTimeAsync(120_000);
      block.resolve("готово");

      await expect(long).resolves.toBe("готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("нулевой потолок отключает ограничение", async () => {
    const queue = new SerialQueue(10, 0);
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("SerialQueue: отказ объясняет обстановку", () => {
  it("при переполнении говорит, сколько задач впереди и сколько примерно ждать", async () => {
    const queue = new SerialQueue(2);
    const block = deferred<void>();

    const running = queue.run(() => block.promise);
    const waiting = queue.run(async () => undefined);

    await expect(queue.run(async () => undefined)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("2 задачи при потолке 2"),
      details: { queued_ahead: 2, max_depth: 2 },
    });

    block.resolve();
    await Promise.all([running, waiting]);
  });

  it("по потолку ожидания сообщает время простоя, очередь и что действие не выполнено", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue(10, 60_000);
      const block = deferred<void>();
      const running = queue.run(() => block.promise);

      const waiting = queue.run(async () => undefined);
      const rejected = expect(waiting).rejects.toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
        message: expect.stringContaining("Действие НЕ выполнено"),
        details: { waited_seconds: 60, max_wait_seconds: 60, queued_ahead: 1, executed: false },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;

      block.resolve();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("прогноз ожидания учится на длительности уже выполненных задач", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerialQueue(10, 1000);

      // Одна задача на две минуты — оценка длительности уезжает вверх.
      const long = queue.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120_000));
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await long;

      const blocker = queue.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120_000));
      });
      const rejected = expect(queue.run(async () => undefined)).rejects.toMatchObject({
        // 30 с начальной оценки, сдвинутые к 120 с одним замером, — заметно больше начальных.
        retryAfterSeconds: expect.any(Number),
        details: { typical_task_seconds: 57 },
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      await blocker;
    } finally {
      vi.useRealTimers();
    }
  });
});
