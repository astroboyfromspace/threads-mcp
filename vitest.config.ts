import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
