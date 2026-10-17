import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    passWithNoTests: true,
    testTimeout: 600_000,
    // The e2e files share the wallet daemons and one channel, so they run one after the other.
    fileParallelism: false,
  },
});
