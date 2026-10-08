import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(url: string, options: { maxConnections?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 10 });
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
