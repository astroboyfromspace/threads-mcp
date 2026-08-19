import { z } from "zod";
import { config } from "../config.js";
import { countRecentSuccesses, logAction } from "../db.js";
import { ActionError } from "../errors.js";
import * as browser from "../browser/actions.js";
import { assertLoggedIn, session } from "../browser/session.js";
import { getClient } from "../graph/token.js";
import * as graph from "../graph/posts.js";

const DAY_SECONDS = 86_400;

export type Driver = "graph" | "browser";

export type ActionDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  driver: Driver;
  input: Schema;
  /** Собственный суточный лимит успешных вызовов. Для Graph-действий не нужен: там квоты считает Threads. */
  dailyLimit?: () => number;
  run: (input: z.infer<Schema>) => Promise<unknown>;
};

/**
 * Стёртая форма для хранения разнотипных действий в одном реестре: дженерик схемы
 * инвариантен, поэтому ActionDefinition<ZodObject<…>> не приводится к общему типу.
 */
export type AnyActionDefinition = {
  name: string;
  description: string;
  driver: Driver;
  input: z.ZodTypeAny;
  dailyLimit?: () => number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (input: any) => Promise<unknown>;
};

function define<Schema extends z.ZodTypeAny>(definition: ActionDefinition<Schema>): ActionDefinition<Schema> {
  return definition;
}

const postUrl = z
  .string()
  .url()
  .refine((value) => value.includes("threads.net") || value.includes("threads.com"), {
    message: "Ожидалась ссылка на пост в Threads",
  });

const username = z.string().min(1).transform((value) => value.replace(/^@/, ""));

const replyControl = z
  .enum(["everyone", "accounts_you_follow", "mentioned_only", "parent_post_author_only", "followers_only"])
  .optional();

export const actions = {
  publish_post: define({
    name: "publish_post",
    description:
      "Опубликовать пост в Threads. Текст обязателен для текстового поста; для картинки или видео нужен публично доступный URL файла.",
    driver: "graph",
    input: z.object({
      text: z.string().max(500).optional(),
      image_url: z.string().url().optional(),
      video_url: z.string().url().optional(),
      alt_text: z.string().max(1000).optional(),
      link_attachment: z.string().url().optional(),
      quote_post_id: z.string().optional(),
      reply_control: replyControl,
      topic_tag: z.string().optional(),
    }),
    run: async (input) => {
      const { client, userId } = await getClient();
      const mediaType: graph.MediaType = input.video_url ? "VIDEO" : input.image_url ? "IMAGE" : "TEXT";
      return graph.publish(client, userId, {
        mediaType,
        text: input.text,
        imageUrl: input.image_url,
        videoUrl: input.video_url,
        altText: input.alt_text,
        linkAttachment: input.link_attachment,
        quotePostId: input.quote_post_id,
        replyControl: input.reply_control,
        topicTag: input.topic_tag,
      });
    },
  }),

  reply_to_post: define({
    name: "reply_to_post",
    description: "Ответить на пост в Threads. Нужен media ID поста, к которому пишем ответ.",
    driver: "graph",
    input: z.object({
      reply_to_id: z.string().min(1),
      text: z.string().min(1).max(500),
      image_url: z.string().url().optional(),
      reply_control: replyControl,
    }),
    run: async (input) => {
      const { client, userId } = await getClient();
      return graph.publish(client, userId, {
        mediaType: input.image_url ? "IMAGE" : "TEXT",
        text: input.text,
        imageUrl: input.image_url,
        replyToId: input.reply_to_id,
        replyControl: input.reply_control,
      });
    },
  }),

  list_my_posts: define({
    name: "list_my_posts",
    description: "Показать мои недавние посты с их media ID и ссылками.",
    driver: "graph",
    input: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      after: z.string().optional(),
    }),
    run: async (input) => {
      const { client, userId } = await getClient();
      return graph.listMyPosts(client, userId, input);
    },
  }),

  list_my_replies: define({
    name: "list_my_replies",
    description: "Показать ответы, которые я оставлял.",
    driver: "graph",
    input: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      after: z.string().optional(),
    }),
    run: async (input) => {
      const { client, userId } = await getClient();
      return graph.listMyReplies(client, userId, input);
    },
  }),

  get_conversation: define({
    name: "get_conversation",
    description:
      "Получить все ответы под моим постом плоским списком — удобно, чтобы отвечать на комментарии. " +
      "Работает только со своими постами: для чужих есть read_replies.",
    driver: "graph",
    input: z.object({
      media_id: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
      reverse: z.boolean().optional(),
      after: z.string().optional(),
    }),
    run: async (input) => {
      const { client } = await getClient();
      return graph.getConversation(client, input.media_id, {
        limit: input.limit,
        reverse: input.reverse,
        after: input.after,
      });
    },
  }),

  delete_post: define({
    name: "delete_post",
    description: "Удалить мой пост или ответ по media ID. Действие необратимо.",
    driver: "graph",
    input: z.object({ media_id: z.string().min(1) }),
    run: async (input) => {
      const { client } = await getClient();
      return graph.deletePost(client, input.media_id);
    },
  }),

  get_quota: define({
    name: "get_quota",
    description: "Сколько постов, ответов и удалений осталось в суточной квоте Threads.",
    driver: "graph",
    input: z.object({}),
    run: async () => {
      const { client, userId } = await getClient();
      return graph.getQuota(client, userId);
    },
  }),

  get_my_profile: define({
    name: "get_my_profile",
    description: "Мой профиль: id, username, имя, био.",
    driver: "graph",
    input: z.object({}),
    run: async () => {
      const { client, userId } = await getClient();
      return graph.getProfile(client, userId);
    },
  }),

  like_post: define({
    name: "like_post",
    description: "Поставить лайк посту по ссылке. Выполняется через браузер.",
    driver: "browser",
    input: z.object({ url: postUrl }),
    dailyLimit: () => config.limits.likesPerDay,
    run: (input) => browser.likePost({ url: input.url }),
  }),

  unlike_post: define({
    name: "unlike_post",
    description: "Снять лайк с поста по ссылке.",
    driver: "browser",
    input: z.object({ url: postUrl }),
    dailyLimit: () => config.limits.likesPerDay,
    run: (input) => browser.unlikePost({ url: input.url }),
  }),

  follow_user: define({
    name: "follow_user",
    description: "Подписаться на пользователя по username.",
    driver: "browser",
    input: z.object({ username }),
    dailyLimit: () => config.limits.followsPerDay,
    run: (input) => browser.followUser(input.username),
  }),

  unfollow_user: define({
    name: "unfollow_user",
    description: "Отписаться от пользователя по username.",
    driver: "browser",
    input: z.object({ username }),
    dailyLimit: () => config.limits.followsPerDay,
    run: (input) => browser.unfollowUser(input.username),
  }),

  repost: define({
    name: "repost",
    description: "Сделать репост поста по ссылке.",
    driver: "browser",
    input: z.object({ url: postUrl }),
    dailyLimit: () => config.limits.repostsPerDay,
    run: (input) => browser.repost({ url: input.url }),
  }),

  remove_repost: define({
    name: "remove_repost",
    description: "Отменить свой репост поста.",
    driver: "browser",
    input: z.object({ url: postUrl }),
    dailyLimit: () => config.limits.repostsPerDay,
    run: (input) => browser.removeRepost({ url: input.url }),
  }),

  read_feed: define({
    name: "read_feed",
    description: "Прочитать ленту подписок: автор, ссылка и текст постов.",
    driver: "browser",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    run: (input) => browser.readFeed(input.limit),
  }),

  read_replies: define({
    name: "read_replies",
    description:
      "Прочитать комментарии под постом по ссылке — в том числе под чужим. Выполняется через браузер, ответы отдаются плоским списком.",
    driver: "browser",
    input: z.object({
      url: postUrl,
      limit: z.number().int().min(1).max(100).default(20),
    }),
    run: (input) => browser.readReplies(input.url, input.limit),
  }),

  read_profile: define({
    name: "read_profile",
    description: "Прочитать посты чужого профиля по username.",
    driver: "browser",
    input: z.object({
      username,
      limit: z.number().int().min(1).max(100).default(20),
    }),
    run: (input) => browser.readProfile(input.username, input.limit),
  }),

  search_posts: define({
    name: "search_posts",
    description:
      "Найти посты по запросу и вернуть карточки выдачи: автор, текст, ссылка, время, счётчики и медиа. " +
      "Сортировка recent отдаёт свежее, top — популярное. Выполняется через браузер.",
    driver: "browser",
    input: z.object({
      query: z.string().trim().min(1).max(100),
      limit: z.number().int().min(1).max(300).default(100),
      sort: z.enum(["top", "recent"]).default("recent"),
    }),
    dailyLimit: () => config.limits.searchesPerDay,
    run: (input) => browser.searchPosts(input.query, input.limit, input.sort),
  }),

  check_login: define({
    name: "check_login",
    description: "Проверить, жива ли браузерная сессия Threads.",
    driver: "browser",
    input: z.object({}),
    run: async () => {
      const result = await session.checkLogin();
      if (result.loggedIn) session.markLoggedIn();
      return result;
    },
  }),
} satisfies Record<string, AnyActionDefinition>;

export type ActionName = keyof typeof actions;

export function isActionName(name: string): name is ActionName {
  return Object.hasOwn(actions, name);
}

/**
 * Действия-читалки: результат может нести сотню карточек постов с текстами.
 * Журнал действий живёт в сервисной БД, которую сборщик датасета намеренно
 * не трогает, — а полный результат в журнале за десяток прогонов превращает
 * этот файл в дубль датасета на десятки мегабайт и делает журнал нечитаемым.
 */
const READER_ACTIONS: ReadonlySet<ActionName> = new Set(["read_feed", "read_profile", "read_replies", "search_posts"]);

/** Короткая сводка вместо полного результата читалки: сколько элементов вернулось. */
function summarizeReaderResult(result: unknown): unknown {
  if (Array.isArray(result)) return { count: result.length };

  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    if (Array.isArray(value.posts)) return { count: value.posts.length };
    if (Array.isArray(value.replies)) return { count: value.replies.length, hasPost: value.post != null };
  }

  return { count: null };
}

/**
 * Единственная точка выполнения действий: валидирует вход, следит за лимитами,
 * пишет журнал. И HTTP, и MCP ходят только сюда.
 */
export async function execute(name: ActionName, rawInput: unknown): Promise<unknown> {
  const action = actions[name] as AnyActionDefinition;

  // Журнал пишется и для отвергнутых вызовов: иначе по логам не отличить
  // «агент не звал действие» от «позвал, но с мусором на входе».
  try {
    const parsed = action.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ActionError("INVALID_INPUT", "Некорректные параметры действия", {
        retryable: false,
        details: parsed.error.flatten(),
      });
    }

    if (action.driver === "browser" && name !== "check_login") {
      assertLoggedIn();
      enforceDailyLimit(action);
    }

    const result = await action.run(parsed.data);
    const loggedResult = READER_ACTIONS.has(name) ? summarizeReaderResult(result) : result;
    logAction({ action: name, driver: action.driver, ok: true, input: parsed.data, result: loggedResult });
    return result;
  } catch (err) {
    const code = err instanceof ActionError ? err.code : "INTERNAL";
    logAction({ action: name, driver: action.driver, ok: false, input: rawInput, errorCode: code });
    throw err;
  }
}

function enforceDailyLimit(action: AnyActionDefinition): void {
  const limit = action.dailyLimit?.();
  if (limit === undefined) return;

  const used = countRecentSuccesses(action.name, DAY_SECONDS);
  if (used >= limit) {
    throw new ActionError(
      "RATE_LIMITED",
      `Суточный лимит действия ${action.name} исчерпан (${used}/${limit}). Лимит намеренно консервативный, чтобы не словить блокировку аккаунта.`,
      { retryable: true, retryAfterSeconds: 3_600 },
    );
  }
}

/** Описание всех действий — для GET /actions и для списка инструментов MCP. */
export function describeActions() {
  return Object.values(actions).map((action) => ({
    name: action.name,
    description: action.description,
    driver: action.driver,
    daily_limit: action.dailyLimit?.() ?? null,
  }));
}
