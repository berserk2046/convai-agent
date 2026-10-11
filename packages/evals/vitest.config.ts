import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

/** Same precedence as `node --env-file`: variables already in the environment win. */
function rootDotEnv(): Record<string, string> {
  const file = new URL("../../.env", import.meta.url);
  if (!existsSync(file)) return {};
  const values = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !(key in process.env)));
}

export default defineConfig({
  test: {
    env: rootDotEnv(),
    // Each integration test file creates and migrates its own database.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
