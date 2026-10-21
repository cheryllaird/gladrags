import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "supabase/**/*.test.ts"],
    // Playwright journey tests live in tests/e2e and run with `pnpm test:e2e`.
    exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
    // Unit tests must never reach the network or real providers.
    env: {
      GLADRAGS_MOCK_MODE: "true",
    },
  },
});
