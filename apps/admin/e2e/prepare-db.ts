import { createTestDatabase } from "@platform/db/testing";
import { createOwner } from "@platform/services";
import { E2E } from "./env.ts";

/**
 * Before the admin starts: a fresh, migrated e2e database with the platform owner. Run
 * with the e2e environment (playwright.config.ts); the server URL creates the database.
 */
process.env.DATABASE_URL = process.env.E2E_SERVER_DATABASE_URL;
const handle = await createTestDatabase({ name: E2E.database });
await createOwner(
  { db: handle.db },
  { email: E2E.ownerEmail, name: "Dueño E2E", password: E2E.ownerPassword },
);
await handle.close();
console.log(`e2e database ${E2E.database} ready`);
