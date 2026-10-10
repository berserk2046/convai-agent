import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessNotFoundError } from "./errors.ts";
import { createBusiness, getBusiness, updateBusinessConfig } from "./repositories/businesses.ts";
import {
  ODONTOLOGIA_SAMPLE_CONFIG,
  ODONTOLOGIA_VERSION,
  publishOdontologia,
} from "./repositories/fixtures.ts";
import { businesses, verticalTemplates, type BusinessRow } from "./schema/index.ts";
import { withTenant } from "./tenant.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

/** Second layer of tenant isolation (principle 6): RLS holds even if app code forgets. */

let testDb: TestDatabase;
let a: BusinessRow;
let b: BusinessRow;
const config = ODONTOLOGIA_SAMPLE_CONFIG;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await publishOdontologia(testDb.db);
  const pinned = { templateSlug: "odontologia", templateVersion: ODONTOLOGIA_VERSION, config };
  a = await createBusiness(testDb.db, { name: "Clínica A", ...pinned });
  b = await createBusiness(testDb.db, { name: "Clínica B", ...pinned });
});

afterAll(async () => {
  await testDb.drop();
});

describe("withTenant", () => {
  it("sees only its own business, even without a WHERE clause", async () => {
    const rows = await withTenant(testDb.db, a.id, (tx) => tx.select().from(businesses));
    expect(rows.map((r) => r.id)).toEqual([a.id]);
  });

  it("can't read or update another business by id", async () => {
    await withTenant(testDb.db, a.id, async (tx) => {
      expect(await getBusiness(tx, b.id)).toBeNull();
      const updated = await tx
        .update(businesses)
        .set({ name: "hacked" })
        .where(eq(businesses.id, b.id))
        .returning();
      expect(updated).toEqual([]);
      await expect(updateBusinessConfig(tx, b.id, config)).rejects.toBeInstanceOf(
        BusinessNotFoundError,
      );
    });
    expect((await getBusiness(testDb.db, b.id))?.name).toBe("Clínica B");
  });

  it("can update its own config through the validating repository", async () => {
    const updated = await withTenant(testDb.db, a.id, (tx) =>
      updateBusinessConfig(tx, a.id, { ...config, city: "Bello" }),
    );
    expect(updated.config?.city).toBe("Bello");
  });

  it("can't create businesses or write templates", async () => {
    await expect(
      withTenant(testDb.db, a.id, (tx) =>
        tx
          .insert(businesses)
          .values({ name: "X", templateSlug: "odontologia", templateVersion: ODONTOLOGIA_VERSION }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      withTenant(testDb.db, a.id, (tx) =>
        tx.update(verticalTemplates).set({ status: "deprecated" }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("can read templates (to render its pinned version)", async () => {
    const rows = await withTenant(testDb.db, a.id, (tx) =>
      tx.select({ slug: verticalTemplates.slug }).from(verticalTemplates),
    );
    expect(rows).toEqual([{ slug: "odontologia" }]);
  });

  it("fails closed when no business is set", async () => {
    const rows = await testDb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      return tx.select().from(businesses);
    });
    expect(rows).toEqual([]);
  });

  it("rejects ids that aren't UUIDs before touching the database", async () => {
    await expect(withTenant(testDb.db, "1 OR 1=1", () => Promise.resolve(0))).rejects.toThrow(
      /must be a UUID/,
    );
  });

  it("drops the tenant role when the transaction ends", async () => {
    await withTenant(testDb.db, a.id, () => Promise.resolve());
    const rows = await testDb.db.select().from(businesses);
    expect(rows).toHaveLength(2);
  });
});
