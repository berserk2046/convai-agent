import { defineConfig } from "vitest/config";

/** Unit tests for the admin's pure helpers; the browser path is Playwright's (e2e/). */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
