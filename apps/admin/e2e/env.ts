/**
 * The end-to-end environment (ADR 0011): its own database on the DATABASE_URL server, a
 * fake Graph API on a fixed port, and fixed test secrets. Shared by the Playwright config,
 * the processes it starts, and the tests. No workspace imports: the config loads this.
 */

export const E2E = {
  adminPort: 3101,
  graphPort: 3911,
  database: "e2e_admin",
  ownerEmail: "owner@e2e.test",
  ownerPassword: "contraseña-del-dueño-e2e",
  /** The channel the test connects: Meta's webhook fixtures use this phone number id. */
  phoneNumberId: "106540352242922",
} as const;

const DEV_DATABASE_URL = "postgres://platform:platform@127.0.0.1:5432/platform";

export function e2eEnv(base: Record<string, string | undefined>): Record<string, string> {
  const server = base.E2E_SERVER_DATABASE_URL ?? base.DATABASE_URL ?? DEV_DATABASE_URL;
  const url = new URL(server);
  url.pathname = `/${E2E.database}`;
  return {
    E2E_SERVER_DATABASE_URL: server,
    DATABASE_URL: url.toString(),
    // 32 bytes of zeros, base64: a test key, never a real one.
    ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    SESSION_SECRET: "e2e-session-secret-with-at-least-32-chars",
    META_GRAPH_VERSION: "v24.0",
    META_GRAPH_BASE_URL: `http://127.0.0.1:${String(E2E.graphPort)}`,
    LOG_LEVEL: "warn",
  };
}
