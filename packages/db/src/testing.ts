import { databaseEnv, parseEnv } from "@platform/shared";
import { createDb, type DbHandle } from "./client.ts";
import { createScratchDatabase, dropScratchDatabase, scratchDatabaseName } from "./scratch.ts";

export interface TestDatabase extends DbHandle {
  url: string;
  name: string;
  /** Closes the pool and drops the database. Call it in `afterAll`. */
  drop(): Promise<void>;
}

/**
 * Creates a fresh, fully migrated database on the DATABASE_URL server. Use one per test
 * file so files can run in parallel without sharing state. A fixed `name` (end-to-end
 * tests, whose web server needs to know it) replaces any database of that name.
 */
export async function createTestDatabase(options: { name?: string } = {}): Promise<TestDatabase> {
  const { DATABASE_URL: serverUrl } = parseEnv(databaseEnv);
  const name = options.name ?? scratchDatabaseName("test");
  if (!/^(test|e2e)_[a-z0-9_]+$/.test(name)) {
    throw new Error(`test database names start with test_ or e2e_, not "${name}"`);
  }
  const url = await createScratchDatabase(serverUrl, name, { replace: options.name !== undefined });
  const handle = createDb(url, { maxConnections: 5 });

  return {
    ...handle,
    url,
    name,
    async drop() {
      await handle.close();
      await dropScratchDatabase(serverUrl, name);
    },
  };
}

export {
  ODONTOLOGIA_MODEL,
  ODONTOLOGIA_SAMPLE_CONFIG,
  ODONTOLOGIA_SOURCE,
  ODONTOLOGIA_VERSION,
  createTestBusiness,
  laterVersion,
  odontologiaAt,
  publishOdontologia,
  recordPassingEvalRun,
} from "./repositories/fixtures.ts";
