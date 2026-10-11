import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { E2E, e2eEnv } from "./e2e/env.ts";

/**
 * The admin smoke test (ADR 0011). Playwright starts fake Graph and Anthropic APIs and the built admin
 * (`next start`, after `next build` in `test:e2e`) on a fresh e2e database. The tests run
 * in one worker: they walk one business through setup, the agent, and the inbox.
 */

// DATABASE_URL may come from the root .env (variables already set win, like --env-file).
const dotEnv = new URL("../../.env", import.meta.url);
const fromFile = existsSync(dotEnv)
  ? (parseEnv(readFileSync(dotEnv, "utf8")) as Record<string, string>)
  : {};
// The web servers and the test workers inherit this environment.
Object.assign(process.env, e2eEnv({ ...fromFile, ...process.env }));

const baseURL = `http://localhost:${String(E2E.adminPort)}`;

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    locale: "es-CO",
    timezoneId: "America/Bogota",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "graph",
      command: "node e2e/fake-graph.ts",
      url: `${process.env.META_GRAPH_BASE_URL ?? ""}/__requests`,
      reuseExistingServer: false,
    },
    {
      name: "anthropic",
      command: "node e2e/fake-anthropic.ts",
      url: `${process.env.ANTHROPIC_BASE_URL ?? ""}/__requests`,
      reuseExistingServer: false,
    },
    {
      name: "admin",
      command: `node e2e/prepare-db.ts && NODE_ENV=production next start --port ${String(E2E.adminPort)}`,
      url: `${baseURL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
