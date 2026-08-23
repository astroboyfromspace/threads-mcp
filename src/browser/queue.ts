import { ActionError } from "../errors.js";

/** Задача, отменённая по потолку ожидания: до неё дошла очередь, но ответ клиенту уже отдан. */
const CANCELLED = Symbol("cancelled");

/** С чего начинаем оценку, пока ни одна задача при этом запуске не отработала. */
const INITIAL_TASK_MS = 30_000;

/** Вес свежего замера в скользящей оценке длительности задачи. */
const SMOOTHING = 0.3;

const seconds = (ms: number): number => Math.max(1, Math.round(ms / 1000));

/** «1 задача», «2 задачи», «5 задач» — иначе отказ читается как машинный лепет. */
function tasks(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} задач`;
  if (last === 1) return `${count} задача`;
  if (last >= 2 && last <= 4) return `${count} задачи`;
  return `${count} задач`;
}

/**
 * Пропускает задачи строго по одной.
 *
 * Браузерный профиль один, и два параллельных обращения к нему — это гонка за
 * состояние страницы. Очередь превращает конкурентные HTTP-запросы в
 * последовательность: каждая задача дожидается своего часа и выполняется
 * целиком, сколько бы ни стояла до этого.
 *
 * Две границы у ожидания всё же есть, и обе — про честность перед клиентом, а
 * не про экономию сил. Первая — глубина: сверх неё работу принимать нечестно,
 * потому что до неё гарантированно не дойдут руки. Вторая — потолок ожидания:
 * запрос живёт не вечно, его держат nginx (proxy_read_timeout) и таймаут
 * клиента, и задача, простоявшая дольше, доедет до браузера уже некому. Такую
 * лучше отменить до старта, чем выполнить втайне: лайк или ответ, о котором
 * никто не узнал, хуже отказа.
 *
 * Оба отказа объясняют обстановку числами — сколько задач впереди, сколько
 * ждали, сколько примерно ждать, — чтобы агент на том конце понимал, что
 * происходит, и не звал то же самое ещё раз параллельно.
 */
export class SerialQueue {
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** Скользящая оценка длительности одной задачи — из неё считаем прогноз ожидания. */
  private taskMs = INITIAL_TASK_MS;

  /** @param maxWaitMs Сколько задача может простоять в очереди, не начавшись. 0 — без потолка. */
  constructor(
    private readonly maxDepth: number,
    private readonly maxWaitMs = 0,
  ) {}

  get depth(): number {
    return this.pending;
  }

  /** Сколько примерно ждать задаче, перед которой стоит `ahead` штук, с. */
  private forecast(ahead: number): number {
    return seconds(ahead * this.taskMs);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const ahead = this.pending;

    if (ahead >= this.maxDepth) {
      const wait = this.forecast(ahead);
      return Promise.reject(
        new ActionError(
          "RATE_LIMITED",
          `Очередь браузера переполнена: ${tasks(ahead)} при потолке ${this.maxDepth}, ждать пришлось бы около ${wait} с. ` +
            "Браузерные действия выполняются строго по одному — дождись текущих и повтори.",
          {
            retryable: true,
            retryAfterSeconds: wait,
            details: { queued_ahead: ahead, max_depth: this.maxDepth, estimated_wait_seconds: wait },
          },
        ),
      );
    }

    this.pending += 1;

    const enqueuedAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = (): Promise<T | typeof CANCELLED> => {
      // Отказ уже улетел клиенту: выполнить действие сейчас значило бы сделать
      // его втайне — лайк или ответ, о котором никто не узнает.
      if (cancelled) return Promise.resolve(CANCELLED);
      if (timer) clearTimeout(timer);

      const startedAt = Date.now();
      const measure = (): void => {
        this.taskMs = this.taskMs * (1 - SMOOTHING) + (Date.now() - startedAt) * SMOOTHING;
      };
      return task().then(
        (value) => {
          measure();
          return value;
        },
        (err: unknown) => {
          measure();
          throw err;
        },
      );
    };

    const runner = this.tail.then(start, start);

    // Хвост не должен унаследовать отказ: одна упавшая задача не обязана
    // ронять все следующие в очереди.
    this.tail = runner.then(
      () => undefined,
      () => undefined,
    );

    const guarded =
      this.maxWaitMs > 0
        ? Promise.race([
            runner,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                cancelled = true;
                const waited = seconds(Date.now() - enqueuedAt);
                reject(
                  new ActionError(
                    "RATE_LIMITED",
                    `Браузер занят: задача простояла в очереди ${waited} с и не начиналась — это потолок ожидания ` +
                      `(${seconds(this.maxWaitMs)} с), дальше держать запрос уже некому. ` +
                      `Впереди неё ${ahead === 1 ? "была" : "было"} ${tasks(ahead)}, каждая занимает около ` +
                      `${seconds(this.taskMs)} с. Действие НЕ выполнено. Браузерные действия идут строго по одному: ` +
                      "зови их последовательно, а не пачкой, и повтори это через какое-то время.",
                    {
                      retryable: true,
                      retryAfterSeconds: this.forecast(this.pending),
                      details: {
                        waited_seconds: waited,
                        max_wait_seconds: seconds(this.maxWaitMs),
                        queued_ahead: ahead,
                        queue_depth: this.pending,
                        typical_task_seconds: seconds(this.taskMs),
                        executed: false,
                      },
                    },
                  ),
                );
              }, this.maxWaitMs);
            }),
          ])
        : runner;

    return (guarded as Promise<T>).finally(() => {
      this.pending -= 1;
      if (timer) clearTimeout(timer);
    });
  }
}
