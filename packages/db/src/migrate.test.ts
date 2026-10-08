import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

async function journalEntryCount(): Promise<number> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

async function appliedMigrationCount(): Promise<number> {
  const result = await testDb.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  return result.rows[0]?.n ?? 0;
}

describe("migrations", () => {
  it("apply every journal entry to a fresh database", async () => {
    expect(await appliedMigrationCount()).toBe(await journalEntryCount());
  });

  it("are idempotent and safe to run concurrently", async () => {
    await Promise.all([runMigrations(testDb.url), runMigrations(testDb.url)]);
    expect(await appliedMigrationCount()).toBe(await journalEntryCount());
  });

  it("install btree_gist", async () => {
    const result = await testDb.pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'",
    );
    expect(result.rowCount).toBe(1);
  });
});

describe("double-booking guard pattern (spec §6)", () => {
  const R1 = "00000000-0000-4000-8000-000000000001";
  const R2 = "00000000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    await testDb.pool.query(`
      CREATE TABLE overlap_probe (
        resource_id uuid NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        status text NOT NULL,
        EXCLUDE USING gist (
          resource_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (status IN ('pending', 'confirmed'))
      )`);
    await insert(R1, "10:00", "10:45", "confirmed");
  });

  async function insert(resource: string, from: string, to: string, status: string) {
    await testDb.pool.query(
      "INSERT INTO overlap_probe VALUES ($1, $2::timestamptz, $3::timestamptz, $4)",
      [resource, `2026-10-08 ${from}-05`, `2026-10-08 ${to}-05`, status],
    );
  }

  it("rejects an overlapping active booking on the same resource", async () => {
    await expect(insert(R1, "10:30", "11:00", "pending")).rejects.toMatchObject({
      code: "23P01", // exclusion_violation
    });
  });

  it("allows back-to-back bookings (half-open ranges)", async () => {
    await expect(insert(R1, "10:45", "11:30", "pending")).resolves.toBeUndefined();
  });

  it("allows the same time on another resource", async () => {
    await expect(insert(R2, "10:00", "10:45", "confirmed")).resolves.toBeUndefined();
  });

  it("ignores cancelled bookings", async () => {
    await expect(insert(R1, "10:00", "10:45", "cancelled")).resolves.toBeUndefined();
  });
});
