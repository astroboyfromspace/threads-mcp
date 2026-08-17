import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { config, ensureDirs } from "../config.js";
import { ActionError } from "../errors.js";
import { SerialQueue } from "./queue.js";
import { LOGGED_OUT_HINTS, URLS } from "./selectors.js";

/**
 * Единственный браузерный контекст сервиса.
 *
 * Профиль постоянный: логин выполняется человеком один раз через noVNC, дальше
 * Playwright переиспользует те же cookies. Пароль нигде не хранится.
 */
class BrowserSession {
  private context: BrowserContext | null = null;
  private readonly queue = new SerialQueue(config.browser.maxQueueDepth);
  private loggedOutSince: number | null = null;
  private suspendedUntil: number | null = null;

  get queueDepth(): number {
    return this.queue.depth;
  }

  get needsLogin(): boolean {
    return this.loggedOutSince !== null;
  }

  get isSuspended(): boolean {
    if (this.suspendedUntil === null) return false;
    if (Date.now() >= this.suspendedUntil) {
      this.suspendedUntil = null;
      return false;
    }
    return true;
  }

  /**
   * Отпускает профиль, чтобы им мог воспользоваться человек через noVNC.
   * Chromium не открывает один user-data-dir дважды, поэтому на время ручного
   * логина сервис обязан закрыть свой контекст.
   */
  async suspend(minutes: number): Promise<{ suspended_until: string }> {
    this.suspendedUntil = Date.now() + minutes * 60_000;
    await this.close();
    return { suspended_until: new Date(this.suspendedUntil).toISOString() };
  }

  /** Возвращает профиль сервису и сразу проверяет, удался ли ручной логин. */
  async resume(): Promise<{ loggedIn: boolean }> {
    this.suspendedUntil = null;
    this.loggedOutSince = null;
    const result = await this.checkLogin();
    return { loggedIn: result.loggedIn };
  }

  /** Ставит задачу в очередь и отдаёт ей страницу. Все браузерные действия идут только сюда. */
  async withPage<T>(task: (page: Page) => Promise<T>): Promise<T> {
    if (this.isSuspended) {
      throw new ActionError(
        "NEEDS_LOGIN",
        "Браузер отдан для ручного логина через noVNC. Закончишь — вызови POST /browser/resume",
        { retryable: true, retryAfterSeconds: 60 },
      );
    }

    return this.queue.run(async () => {
      const context = await this.ensureContext();
      const page = await context.newPage();
      try {
        return await task(page);
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    ensureDirs();

    this.context = await chromium.launchPersistentContext(config.paths.browserProfile, {
      headless: !config.browser.headed,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.context.on("close", () => {
      this.context = null;
    });

    return this.context;
  }

  /** Проверяет, жива ли сессия. Вызывается при старте и периодически. */
  async checkLogin(): Promise<{ loggedIn: boolean; username?: string }> {
    return this.withPage(async (page) => {
      await page.goto(URLS.home, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2_000);

      const url = page.url();
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";

      const redirectedToLogin = url.includes("/login");
      const looksLoggedOut =
        redirectedToLogin || LOGGED_OUT_HINTS.some((hint) => hint.test(body.slice(0, 2_000)));

      if (looksLoggedOut) {
        this.loggedOutSince ??= Date.now();
        return { loggedIn: false };
      }

      this.loggedOutSince = null;
      return { loggedIn: true };
    });
  }

  markLoggedOut(): void {
    this.loggedOutSince ??= Date.now();
  }

  markLoggedIn(): void {
    this.loggedOutSince = null;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
  }
}

export const session = new BrowserSession();

/** Бросает NEEDS_LOGIN, если сессия протухла — чтобы агент получил внятную причину. */
export function assertLoggedIn(): void {
  if (session.needsLogin) {
    throw new ActionError(
      "NEEDS_LOGIN",
      "Браузерная сессия Threads разлогинена. Зайди в noVNC и авторизуйся вручную, потом вызови POST /browser/login-check",
      { retryable: false },
    );
  }
}

/**
 * Пауза между браузерными действиями со случайным разбросом.
 * Ровный интервал — самый заметный признак автоматизации.
 */
export function humanDelay(): Promise<void> {
  const { minDelayMs, maxDelayMs } = config.browser;
  const ms = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сохраняет скриншот, когда браузер не нашёл ожидаемый элемент: чинить вслепую невозможно. */
export async function captureFailure(page: Page, label: string): Promise<string> {
  const file = join(config.paths.failures, `${label}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}
