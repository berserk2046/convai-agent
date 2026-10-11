import { randomBytes } from "node:crypto";
import pg from "pg";
import { connectionError } from "./connection.ts";
import { runMigrations } from "./migrate.ts";
import { withDatabaseName } from "./url.ts";

/**
 * Throwaway databases on the platform's Postgres server, fully migrated: one per test file,
 * per eval run and per playground session (ADR 0015). The app's role needs CREATEDB.
 *
 * Names are `<prefix>_<created, base-36 seconds>_<random>`, so a cleanup job can tell how
 * old a database is without asking the server, and only these prefixes are ever dropped.
 */

export const SCRATCH_PREFIXES = ["test", "e2e", "eval", "play"] as const;
export type ScratchPrefix = (typeof SCRATCH_PREFIXES)[number];

const NAME = /^(test|e2e|eval|play)_[a-z0-9_]+$/;

export function scratchDatabaseName(prefix: ScratchPrefix, now = new Date()): string {
  const created = Math.floor(now.getTime() / 1000).toString(36);
  return `${prefix}_${created}_${randomBytes(6).toString("hex")}`;
}

/** When a scratch database was named, or null for names without the time part. */
export function scratchCreatedAt(name: string): Date | null {
  const match = /^[a-z0-9]+_([a-z0-9]+)_[0-9a-f]{12}$/.exec(name);
  if (!match?.[1]) return null;
  const seconds = Number.parseInt(match[1], 36);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

export function isScratchName(name: string): boolean {
  return NAME.test(name);
}

/**
 * Creates and migrates a scratch database next to `serverUrl`'s; returns its URL. With
 * `replace`, a database of that name is dropped first (end-to-end tests use fixed names).
 */
export async function createScratchDatabase(
  serverUrl: string,
  name: string,
  options: { replace?: boolean } = {},
): Promise<string> {
  assertScratchName(name);
  if (options.replace) await runOnServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await runOnServer(serverUrl, `CREATE DATABASE ${name}`);
  const url = withDatabaseName(serverUrl, name);
  try {
    await runMigrations(url);
  } catch (error) {
    await dropScratchDatabase(serverUrl, name);
    throw error;
  }
  return url;
}

export async function dropScratchDatabase(serverUrl: string, name: string): Promise<void> {
  assertScratchName(name);
  await runOnServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** Scratch databases on the server with this prefix. */
export async function listScratchDatabases(
  serverUrl: string,
  prefix: ScratchPrefix,
): Promise<string[]> {
  const rows = await queryServer<{ datname: string }>(
    serverUrl,
    "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
    [`${prefix}\\_%`],
  );
  return rows.map((r) => r.datname).filter(isScratchName);
}

function assertScratchName(name: string): void {
  // Interpolated into DDL, so the pattern is also the injection guard.
  if (!NAME.test(name)) {
    throw new Error(
      `scratch database names start with ${SCRATCH_PREFIXES.join("_, ")}_, not "${name}"`,
    );
  }
}

async function runOnServer(serverUrl: string, sql: string): Promise<void> {
  await queryServer(serverUrl, sql, []);
}

async function queryServer<Row extends pg.QueryResultRow>(
  serverUrl: string,
  sql: string,
  values: unknown[],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: serverUrl });
  try {
    await client.connect();
  } catch (error) {
    throw connectionError(serverUrl, error);
  }
  try {
    return (await client.query<Row>(sql, values)).rows;
  } finally {
    await client.end();
  }
}
