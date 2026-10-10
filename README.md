# Agent platform

WhatsApp AI agents and automatic messages for small businesses in Colombia. Each business
type is a vertical template (versioned YAML), not code. See `CLAUDE.md` and
`docs/architecture.md`.

## Requirements

- Node.js ≥ 24.7 (CI uses 24; see `.node-version`)
- pnpm 12 (`npm install -g pnpm@12`)
- Docker with Compose

## Quick start

```sh
pnpm i
docker compose up -d   # Postgres 16 + Redis on 127.0.0.1
pnpm db:migrate
pnpm test
```

The tests need no `.env`: database and Redis URLs default to the compose services. The
apps do: copy `.env.example` to `.env` and fill in `ENCRYPTION_KEY`, `SESSION_SECRET` and
`META_GRAPH_VERSION` (the comments say how).

## Admin

```sh
pnpm db:migrate        # again after pulling: M5 added the users and sessions tables
read -rs OWNER_PASSWORD && export OWNER_PASSWORD
OWNER_EMAIL=you@example.com OWNER_NAME="Your Name" pnpm admin:create-owner
pnpm dev:admin         # http://localhost:3001
```

Log in as the owner, upload `templates/odontologia/template.yaml` under Templates, publish it,
and create a business. "Impersonate" opens the business screens as its admin.

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
| `pnpm dev:admin`                    | The admin app (Next.js dev server on port 3001)                             |
| `pnpm admin:create-owner`           | Create a platform owner (reads `OWNER_*` from the environment)              |
| `pnpm test:e2e`                     | Build the admin and run the Playwright smoke test (needs Postgres)          |

`docker compose down -v` wipes the local database and Redis.
