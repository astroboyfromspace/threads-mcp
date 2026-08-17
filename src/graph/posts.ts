import { ActionError } from "../errors.js";
import type { GraphClient } from "./client.js";

export type MediaType = "TEXT" | "IMAGE" | "VIDEO";

export type ContainerInput = {
  mediaType: MediaType;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  altText?: string;
  linkAttachment?: string;
  replyToId?: string;
  quotePostId?: string;
  replyControl?: "everyone" | "accounts_you_follow" | "mentioned_only" | "parent_post_author_only" | "followers_only";
  topicTag?: string;
  isCarouselItem?: boolean;
};

type IdResponse = { id: string };
type ContainerStatus = { id: string; status: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"; error_message?: string };

function toBody(input: ContainerInput): Record<string, string | boolean | undefined> {
  return {
    media_type: input.mediaType,
    text: input.text,
    image_url: input.imageUrl,
    video_url: input.videoUrl,
    alt_text: input.altText,
    link_attachment: input.linkAttachment,
    reply_to_id: input.replyToId,
    quote_post_id: input.quotePostId,
    reply_control: input.replyControl,
    topic_tag: input.topicTag,
    is_carousel_item: input.isCarouselItem,
  };
}

/**
 * Публикует пост или ответ.
 *
 * Текстовые посты уходят одним запросом через auto_publish_text. Посты с медиа
 * требуют двух шагов: Threads должен успеть скачать файл по URL, поэтому между
 * созданием контейнера и публикацией мы дожидаемся статуса FINISHED.
 */
export async function publish(client: GraphClient, userId: string, input: ContainerInput): Promise<{ id: string }> {
  if (input.mediaType === "TEXT") {
    if (!input.text?.trim()) {
      throw new ActionError("INVALID_INPUT", "Для текстового поста нужен непустой text");
    }
    const created = await client.post<IdResponse>(`${userId}/threads`, {
      ...toBody(input),
      auto_publish_text: true,
    });
    return { id: created.id };
  }

  if (input.mediaType === "IMAGE" && !input.imageUrl) {
    throw new ActionError("INVALID_INPUT", "Для media_type=IMAGE нужен публично доступный image_url");
  }
  if (input.mediaType === "VIDEO" && !input.videoUrl) {
    throw new ActionError("INVALID_INPUT", "Для media_type=VIDEO нужен публично доступный video_url");
  }

  const container = await client.post<IdResponse>(`${userId}/threads`, toBody(input));
  await waitUntilReady(client, container.id);
  const published = await client.post<IdResponse>(`${userId}/threads_publish`, { creation_id: container.id });
  return { id: published.id };
}

/**
 * Ждёт, пока Threads обработает медиаконтейнер. Видео обрабатывается заметно
 * дольше картинок, поэтому опрашиваем статус, а не спим фиксированные 30 секунд.
 */
async function waitUntilReady(client: GraphClient, containerId: string, timeoutMs = 5 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 3_000;

  while (Date.now() < deadline) {
    const status = await client.get<ContainerStatus>(containerId, { fields: "status,error_message" });

    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED") {
      throw new ActionError("UPSTREAM", `Threads не смог обработать медиа: ${status.error_message ?? status.status}`, {
        retryable: false,
      });
    }

    await sleep(delayMs);
    delayMs = Math.min(delayMs * 1.5, 15_000);
  }

  throw new ActionError("UPSTREAM", "Threads не обработал медиа за отведённое время", { retryable: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POST_FIELDS = [
  "id",
  "media_product_type",
  "media_type",
  "media_url",
  "permalink",
  "username",
  "text",
  "timestamp",
  "shortcode",
  "is_quote_post",
  "has_replies",
  "reply_audience",
].join(",");

const REPLY_FIELDS = [
  "id",
  "media_type",
  "permalink",
  "username",
  "text",
  "timestamp",
  "has_replies",
  "root_post",
  "replied_to",
  "is_reply",
  "is_reply_owned_by_me",
  "hide_status",
].join(",");

export type Paged<T> = { data: T[]; paging?: { cursors?: { before?: string; after?: string } } };

export function listMyPosts(
  client: GraphClient,
  userId: string,
  opts: { limit?: number; since?: string; until?: string; after?: string } = {},
): Promise<Paged<Record<string, unknown>>> {
  return client.get(`${userId}/threads`, { fields: POST_FIELDS, ...opts });
}

export function listMyReplies(
  client: GraphClient,
  userId: string,
  opts: { limit?: number; since?: string; until?: string; after?: string } = {},
): Promise<Paged<Record<string, unknown>>> {
  return client.get(`${userId}/replies`, { fields: REPLY_FIELDS, ...opts });
}

/** Плоский список всех ответов в треде — удобно, когда глубина вложенности не важна. */
export function getConversation(
  client: GraphClient,
  mediaId: string,
  opts: { limit?: number; reverse?: boolean; after?: string } = {},
): Promise<Paged<Record<string, unknown>>> {
  return client.get(`${mediaId}/conversation`, {
    fields: REPLY_FIELDS,
    reverse: opts.reverse === undefined ? undefined : String(opts.reverse),
    limit: opts.limit,
    after: opts.after,
  });
}

export function deletePost(client: GraphClient, mediaId: string): Promise<{ success: boolean }> {
  return client.delete(mediaId);
}

export type QuotaUsage = {
  posts: { used: number; total: number };
  replies: { used: number; total: number };
  deletes: { used: number; total: number };
};

type QuotaResponse = {
  data: Array<{
    quota_usage?: number;
    config?: { quota_total?: number };
    reply_quota_usage?: number;
    reply_config?: { quota_total?: number };
    delete_quota_usage?: number;
    delete_config?: { quota_total?: number };
  }>;
};

/** Реальное потребление квот по данным самого Threads, а не по нашим счётчикам. */
export async function getQuota(client: GraphClient, userId: string): Promise<QuotaUsage> {
  const response = await client.get<QuotaResponse>(`${userId}/threads_publishing_limit`, {
    fields: "quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config",
  });
  const row = response.data[0] ?? {};
  return {
    posts: { used: row.quota_usage ?? 0, total: row.config?.quota_total ?? 250 },
    replies: { used: row.reply_quota_usage ?? 0, total: row.reply_config?.quota_total ?? 1000 },
    deletes: { used: row.delete_quota_usage ?? 0, total: row.delete_config?.quota_total ?? 100 },
  };
}

export function getProfile(client: GraphClient, userId: string): Promise<Record<string, unknown>> {
  return client.get(userId, {
    fields: "id,username,name,threads_profile_picture_url,threads_biography",
  });
}
