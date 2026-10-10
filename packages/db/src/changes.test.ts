import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INBOX_CHANNEL, createChangeFeed, type ChangeFeed } from "./changes.ts";
import { ensureConversation, upsertContact } from "./repositories/conversations.ts";
import { createTestBusiness } from "./repositories/fixtures.ts";
import type { BusinessRow } from "./schema/index.ts";
import { withTenant } from "./tenant.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let testDb: TestDatabase;
let feed: ChangeFeed;
let a: BusinessRow;
let b: BusinessRow;
let number = 0;

/** A committed change the inbox shows: a new contact and its conversation. */
async function touch(business: BusinessRow): Promise<void> {
  number += 1;
  await withTenant(testDb.db, business.id, async (tx) => {
    const contact = await upsertContact(
      tx,
      business.id,
      `57300000${String(number).padStart(4, "0")}`,
    );
    await ensureConversation(tx, business.id, contact.id);
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  a = await createTestBusiness(testDb.db, "Clínica A");
  b = await createTestBusiness(testDb.db, "Clínica B");
  feed = createChangeFeed(testDb.url, { channel: INBOX_CHANNEL, maxRetryMs: 200 });
});

afterAll(async () => {
  await feed.close();
  await testDb.drop();
});

describe("inbox change feed (migration 0013)", () => {
  it("tells only the business whose rows changed, once per transaction", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = feed.subscribe(a.id, onA);
    const offB = feed.subscribe(b.id, onB);
    await feed.ready();

    await touch(a);
    await vi.waitFor(() => {
      expect(onA).toHaveBeenCalledOnce();
    });
    // Two rows in one transaction, one notification. Then B's change arrives, and A's
    // count shows nothing else came for A.
    await touch(b);
    await vi.waitFor(() => {
      expect(onB).toHaveBeenCalledOnce();
    });
    expect(onA).toHaveBeenCalledOnce();
    offA();
    offB();
  });

  it("sends nothing for a rolled-back change, and nothing after unsubscribing", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = feed.subscribe(a.id, onA);
    const offB = feed.subscribe(b.id, onB);

    await expect(
      withTenant(testDb.db, a.id, async (tx) => {
        await upsertContact(tx, a.id, "573009999999");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    offA();
    await touch(a);
    await touch(b);
    await vi.waitFor(() => {
      expect(onB).toHaveBeenCalledTimes(1);
    });
    expect(onA).not.toHaveBeenCalled();
    offB();
  });

  it("reconnects after losing its connection and tells every subscriber to catch up", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = feed.subscribe(a.id, onA);
    const offB = feed.subscribe(b.id, onB);
    await feed.ready();

    await testDb.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
    );
    await vi.waitFor(() => {
      expect(onA).toHaveBeenCalledOnce();
      expect(onB).toHaveBeenCalledOnce();
    });

    await touch(a);
    await vi.waitFor(() => {
      expect(onA).toHaveBeenCalledTimes(2);
    });
    offA();
    offB();
  });
});
