# Agent platform

WhatsApp AI agents and automatic messages for small businesses in Colombia. Each business
type is a vertical template (versioned YAML), not code. See `CLAUDE.md` and
`docs/architecture.md`.

## Requirements

- Node.js ≥ 24 LTS (CI uses 24; see `.node-version`)
- pnpm 12 (`npm install -g pnpm@12`)
- Docker with Compose

## Quick start

```sh
pnpm i
docker compose up -d   # Postgres 16 + Redis on 127.0.0.1
pnpm db:migrate
pnpm test
```

No `.env` is needed for local development: database and Redis URLs default to the compose
services. Copy `.env.example` to `.env` to override anything.

## Everyday commands

| Command                             | What it does                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `pnpm test`                         | Unit and integration tests (each test file gets its own throwaway database) |
| `pnpm lint` / `pnpm typecheck`      | ESLint (type-aware) / `tsc` across packages                                 |
| `pnpm format` / `pnpm format:check` | Prettier                                                                    |
| `pnpm db:migrate`                   | Apply migrations to `DATABASE_URL`                                          |
| `pnpm db:generate`                  | Generate a migration from schema changes                                    |
| `pnpm db:new <name>`                | Empty custom SQL migration (constraints, RLS)                               |
| `pnpm template validate <path>`     | Validate a vertical template (see `docs/templates.md`)                      |
| `pnpm dev:api` / `pnpm dev:worker`  | Run the webhook API / the worker in watch mode                              |
| `pnpm dev:setup`                    | Demo business on Meta's test number (`docs/whatsapp-test-number.md`)        |

`docker compose down -v` wipes the local database and Redis.
