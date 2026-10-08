import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";

/** A transaction handle; repositories accept either this or the root database. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Transaction;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Runs `work` in a transaction scoped to one business: Postgres row-level security then
 * hides every other tenant's rows (migration 0002). `businessId` must come from the
 * session or the resolved channel, never from request input (principle 6).
 */
export async function withTenant<T>(
  db: Database,
  businessId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(businessId)) throw new Error("withTenant: businessId must be a UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_tenant`);
    await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
    return work(tx);
  });
}
