import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { describeDatabaseUrl } from "./url.ts";

/** Errors worth retrying while the server boots: refused/reset sockets, "starting up". */
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "57P03"]);

export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/** Wraps a connection failure with the target (no credentials) and a hint. */
export function connectionError(url: string, cause: unknown): Error {
  const target = describeDatabaseUrl(url);
  const message = isTransientConnectionError(cause)
    ? `Postgres is not reachable at ${target}. Is it running? (docker compose up -d)`
    : `Cannot connect to Postgres at ${target}: ${cause instanceof Error ? cause.message : String(cause)}`;
  return new Error(message, { cause });
}

/**
 * Waits until Postgres accepts connections. `docker compose up -d` returns before the
 * server is ready, and the documented setup runs `pnpm db:migrate` right after it.
 */
export async function waitForPostgres(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      if (!isTransientConnectionError(error) || Date.now() >= deadline) {
        throw connectionError(url, error);
      }
    }
    await sleep(500);
  }
}
