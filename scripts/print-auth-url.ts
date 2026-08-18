/**
 * Печатает ссылку авторизации Threads.
 *
 * Нужна при развёртывании: ссылку открывает владелец аккаунта в своём браузере,
 * а код подхватывает /oauth/callback самого сервиса — вручную ничего копировать
 * не надо.
 *
 *   docker compose exec api node dist/scripts/print-auth-url.js
 */
import { buildAuthorizationUrl } from "../src/graph/token.js";

const SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_delete",
] as const;

console.log(buildAuthorizationUrl(SCOPES));
