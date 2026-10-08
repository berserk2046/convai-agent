import { randomUUID } from "node:crypto";
import { databaseEnv, parseEnv } from "@platform/shared";
import pg from "pg";
import { createDb, type DbHandle } from "./client.ts";
import { connectionError } from "./connection.ts";
import { runMigrations } from "./migrate.ts";
import { withDatabaseName } from "./url.ts";

export interface TestDatabase extends DbHandle {
  url: string;
  name: string;
  /** Closes the pool and drops the database. Call it in `afterAll`. */
  drop(): Promise<void>;
}

/**
 * Creates a fresh, fully migrated database on the DATABASE_URL server. Use one per test
 * file so files can run in parallel without sharing state.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { DATABASE_URL: serverUrl } = parseEnv(databaseEnv);
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await runOnServer(serverUrl, `CREATE DATABASE ${name}`);

  const url = withDatabaseName(serverUrl, name);
  await runMigrations(url);
  const handle = createDb(url, { maxConnections: 5 });

  return {
    ...handle,
    url,
    name,
    async drop() {
      await handle.close();
      await runOnServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function runOnServer(serverUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  try {
    await client.connect();
  } catch (error) {
    throw connectionError(serverUrl, error);
  }
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export {
  ODONTOLOGIA_SAMPLE_CONFIG,
  ODONTOLOGIA_SOURCE,
  createTestBusiness,
  publishOdontologia,
} from "./repositories/fixtures.ts";
