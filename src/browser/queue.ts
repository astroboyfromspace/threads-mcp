import { ActionError } from "../errors.js";

/**
 * Пропускает задачи строго по одной.
 *
 * Браузерный профиль один, и два параллельных обращения к нему — это гонка за
 * состояние страницы. Очередь превращает конкурентные HTTP-запросы в
 * последовательность, а при переполнении честно отказывает вместо того, чтобы
 * копить работу, которую всё равно не успеет сделать.
 */
export class SerialQueue {
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly maxDepth: number) {}

  get depth(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxDepth) {
      return Promise.reject(
        new ActionError("RATE_LIMITED", `Очередь браузера переполнена (${this.pending} задач), попробуй позже`, {
          retryable: true,
          retryAfterSeconds: 30,
        }),
      );
    }

    this.pending += 1;
    const result = this.tail.then(task, task);

    // Хвост не должен унаследовать отказ: одна упавшая задача не обязана
    // ронять все следующие в очереди.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.pending -= 1;
    });
  }
}
