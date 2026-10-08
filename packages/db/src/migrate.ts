import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Serializes concurrent runs, e.g. api and worker starting together. Any constant works. */
const MIGRATION_LOCK_KEY = 7_204_250_001;

/** Applies pending migrations (drizzle-kit format) in one transaction. */
export async function runMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    // The advisory lock is session-scoped, so closing the connection releases it.
    await client.end();
  }
}
