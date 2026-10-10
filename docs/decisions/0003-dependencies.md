# 0003 — Dependencies beyond spec §4

Status: living list.

## Policy

The owner approved adding dependencies that are genuinely needed, with a strong preference
for a lean tree that stays easy to debug. Before adding a package:

1. Check whether Node built-ins or an existing dependency already cover the need.
2. If it is still needed, add it here with a one-line reason.
3. Mention it in the milestone summary.

## Added

| Package               | Scope   | Why                                                                  | Milestone |
| --------------------- | ------- | -------------------------------------------------------------------- | --------- |
| `typescript-eslint`   | dev     | Parser and rules for linting TypeScript (type-aware)                 | M0        |
| `@eslint/js`          | dev     | ESLint's core recommended rule set (separate package since ESLint 9) | M0        |
| `@types/node` (`^24`) | dev     | Node type definitions, pinned to the minimum supported runtime       | M0        |
| `pg` + `@types/pg`    | runtime | Postgres driver that Drizzle runs on                                 | M0        |
| `drizzle-kit`         | dev     | Generates SQL migrations from the Drizzle schema                     | M0        |

Spec §4 packages in use:

- M0: `zod`, `pino`.
- M1: `ajv`, `ajv-formats`, `yaml`, `liquidjs`, `luxon`.
- M2: `fastify`, `bullmq`.
- M3: `@anthropic-ai/sdk` (`packages/llm`). The new scheduling, llm and core code reuses
  `luxon`, `zod` and `bullmq`. No non-spec packages were added.
- M4: none. `@platform/automations` reuses `bullmq`, `ioredis` and `luxon`. Cron
  expressions are matched by a small parser in the package rather than a cron library.
- M5 (`apps/admin`, ADR 0011): `next` 16.3.8 with `react`/`react-dom` 19.3, `tailwindcss`
  4.3, `@rjsf/core` 6.11, and `@playwright/test` 1.64 for the smoke test.
  `@platform/services` reuses `yaml` for template diffs.

| Package        | Scope   | Why                                                                                   | Milestone |
| -------------- | ------- | ------------------------------------------------------------------------------------- | --------- |
| `@types/luxon` | dev     | Type definitions for Luxon (it ships none)                                            | M1        |
| `ioredis`      | runtime | BullMQ 6 made its Redis client an optional peer; we use the one BullMQ is tested with | M2        |

| Package                               | Scope   | Why                                                                  | Milestone |
| ------------------------------------- | ------- | -------------------------------------------------------------------- | --------- |
| `@rjsf/utils`, `@rjsf/validator-ajv8` | runtime | Required companions of `@rjsf/core`: its types and its Ajv validator | M5        |
| `@tailwindcss/postcss`                | dev     | Tailwind 4's PostCSS plugin, how Next.js loads Tailwind              | M5        |
| `@types/react`, `@types/react-dom`    | dev     | React type definitions (React ships none)                            | M5        |

## Deliberately not added

- **`tsx`, `ts-node`, bundlers:** Node's type stripping runs our TS (ADR 0001).
- **`dotenv`:** `node --env-file-if-exists` and `util.parseEnv` are built in.
- **`eslint-config-prettier`, `globals`:** no conflicting rules enabled, and nothing needs
  them.
- **`pino-pretty`:** JSON logs only. Pipe through `jq` locally if needed.
- **`semver`:** template versions need parse and compare only (`templates/src/semver.ts`).
- **`zod-to-json-schema`:** Zod 4 has `z.toJSONSchema()` built in.
- **`libsodium-wrappers`:** `node:crypto` AES-256-GCM instead (ADR 0006).
- **`axios`/`undici` wrappers, `@fastify/*` plugins, `fastify-raw-body`:** Node's `fetch`
  and a Fastify content-type parser cover the need.
- **shadcn/ui's CLI, Radix, `clsx`, `tailwind-merge`, `lucide-react`:** the admin's few
  components are vendored with native elements and a one-line `cn` (ADR 0011).
- **`argon2`/`bcrypt` (native add-ons):** Node ≥ 24.7 has `crypto.argon2` (ADR 0011).
- **`next-auth`, `iron-session`, `jose`:** sessions are database rows with an HMAC'd random
  token; there is nothing to sign or encrypt client-side.
- **`eslint-config-next`, `eslint-plugin-react-hooks`:** the shared typescript-eslint config
  covers the admin; Next 16 no longer runs ESLint itself.
- **Native build scripts:** `esbuild` and `msgpackr-extract` are denied in
  `pnpm-workspace.yaml`; both work without them.
