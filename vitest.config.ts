import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next's tsconfig leaves JSX for Next's own compiler; component tests need
  // it compiled with the automatic React runtime.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Logic tests run in Node. Component tests (*.test.tsx) opt in to a
    // browser-like DOM with a `// @vitest-environment jsdom` comment.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "supabase/**/*.test.ts"],
    setupFiles: ["./src/test/setup-dom.ts"],
    // Playwright journey tests live in tests/e2e and run with `pnpm test:e2e`.
    exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
    // Unit tests must never reach the network or real providers.
    env: {
      GLADRAGS_MOCK_MODE: "true",
    },
  },
});
