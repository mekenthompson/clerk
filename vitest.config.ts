import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // history.test.ts uses bun:sqlite which is a Bun built-in. vitest
    // runs under vite/Node and can't resolve it. The history tests are
    // run separately via `bun test telegram-plugin/tests/history.test.ts`
    // (see the `test` script in package.json).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/telegram-plugin/tests/history.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["telegram-plugin/**"],
      exclude: [
        "telegram-plugin/tests/**",
        "telegram-plugin/server.ts",
        "telegram-plugin/start.ts",
        "telegram-plugin/pty-tail.ts",
        "telegram-plugin/history.ts",
        "telegram-plugin/session-tail.ts",
      ],
    },
  },
});
