import { describe, expect, it } from "vitest";
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
