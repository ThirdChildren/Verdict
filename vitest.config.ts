import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // "@/" is the shadcn alias of apps/demo-ui (no other package uses it).
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(import.meta.dirname, "apps/demo-ui/src") + "/" },
    ],
  },
  test: {
    passWithNoTests: true,
    include: ["{packages,services,apps}/*/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    // tsc -b emits the tests into dist/; never collect those stale copies (a bare `vitest` in a package did).
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/dist-types/**"],
  },
});
