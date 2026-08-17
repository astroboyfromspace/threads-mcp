import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Конфиг читается при импорте модулей, поэтому переменные должны существовать
// до того, как тест дотянется до src/config.ts.
process.env.API_TOKEN ??= "test-token";
process.env.THREADS_APP_ID ??= "test-app-id";
process.env.THREADS_APP_SECRET ??= "test-app-secret";
process.env.THREADS_REDIRECT_URI ??= "https://example.test/oauth/callback";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "threads-api-test-"));
