import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/e2e/**/*.e2e.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
