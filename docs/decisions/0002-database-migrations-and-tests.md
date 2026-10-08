# 0002 — Migrations and database tests

Status: accepted (M0)

## Decision

- **Schema:** Drizzle table definitions in `packages/db/src/schema/`.
- **Migrations:** SQL files in `packages/db/migrations/`, in drizzle-kit's journal format.
  - `pnpm db:generate` diffs the TS schema into a new SQL migration.
  - `pnpm db:new <name>` creates an empty custom migration for what Drizzle can't express:
    the bookings exclusion constraint, RLS policies, roles.
  - Generated SQL is reviewed and committed. Applied migrations are never edited.
- **Applying:** `runMigrations()` uses drizzle-orm's migrator. It takes a Postgres advisory
  lock first, so concurrent runs (api and worker starting together) serialize instead of
  racing. Pending migrations apply in one transaction.
- **Startup race:** the `pnpm db:migrate` CLI waits up to 30 s for Postgres to accept
  connections, because `docker compose up -d` returns before the server is ready. It only
  retries boot-time errors (refused/reset, "starting up"). Auth errors and a missing
  database fail at once.
- **Dev defaults:** outside production, `DATABASE_URL` and `REDIS_URL` default to the
  compose services, so a fresh clone works without `.env`. In production they are required.
- **Integration tests:** each test file calls `createTestDatabase()` (from
  `@platform/db/testing`). It creates `test_<uuid>` on the `DATABASE_URL` server, applies all
  migrations, and drops it in `afterAll`. Files run in parallel with no shared state, and
  every run exercises the real migrations. When Postgres is down, tests fail with a hint;
  they never skip.
- **Driver:** node-postgres (`pg`).

## Consequences

- Tests need the compose Postgres (or `DATABASE_URL` pointing at a server where the user
  may `CREATE DATABASE`).
- A test process that is killed hard can leave `test_*` databases behind.
  `docker compose down -v` resets everything.
