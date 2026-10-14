# CLAUDE.md

WhatsApp AI agents and automatic messages for small businesses in Colombia. Each business
type (dental clinic, vet, restaurant…) is a **vertical template**: a versioned YAML data
package, not code.

- Full spec: `CLAUDE_CODE_BUILD_PROMPT.md` (source of truth).
- Architecture summary: `docs/architecture.md`.
- Decisions (ADRs): `docs/decisions/`.
- Open questions and risks in the spec: `docs/spec-review.md`.

## Status

Update this section at the end of each milestone.

- **Done and approved:** M0–M6, all on `main`.
  - M5 is the admin app: auth and roles, every §12 screen, the instant inbox (ADR 0013),
    WhatsApp cost recording (ADR 0012) and display labels in templates (ADR 0014).
  - M6 is the evals and the playground (ADR 0015, ADR 0016): the eval runner on scratch
    databases with record/replay and a Sonnet judge, the publish gate, eval reports and
    **Run evals** in the admin, `/playground`, `pnpm template eval|push|publish`, CI replay
    and the nightly live workflow.
  - The dental template is `1.2.0` on Claude Haiku 5.5 (ADR 0017). Its 18 scenarios
    pass live 54/54, gate passed. The owner's behavior rules from 2026-10-11 are in
    ADR 0018: offer nearby days, never apologize for "not checking", and explain the
    booking window.
- **Next:** M7, pilot hardening and deploy (spec §15). Start it only when the owner asks.
- **Waiting on the owner:**
  - Live checks on Meta's test number (M2–M5). They are blocked until the owner's Meta
    business account is sorted out. The steps are in `docs/whatsapp-test-number.md`. The
    Anthropic key exists since 2026-10-10.
  - The `ANTHROPIC_API_KEY` repository secret, for the nightly live evals (about $0.065 a
    run). The live evals themselves ran on 2026-10-10 (ADR 0017).
  - Submitting the message templates to Meta (`META_TEMPLATE_SUBMISSION`). Ask again once
    the Meta account works.
  - A review of how the admin looks. Start from `docs/admin-ui.md`.
- **Carry into M7:**
  - Check that Caddy streams `/inbox/events` unbuffered (ADR 0013).
  - The production database role needs `CREATEDB` for eval runs and the playground (ADR
    0015).
- **Local setup after pulling:** run `pnpm db:migrate` (M6 adds `eval_runs` and
  `playground_sessions`). The dental template is at 1.2.0; a local business on an older
  version moves with the owner's upgrade screen.
- **Spending (owner's rule, 2026-10-10):**
  - The Anthropic account had $5 of credit. $0.294 was spent by 2026-10-11 (about $4.71
    left), and part of it is kept for M7.
  - Paid runs (anything that calls the Claude API for money) need the owner's explicit OK
    first. Free runs (tests with fakes, replays, token counting) don't.
  - Before each run, give its estimated cost; after it, report what it used.
  - Live CLI runs use `--max-cost`.

## How to work

- Work milestone by milestone (spec §15, M0 → M9). At the end of each milestone:
  `pnpm lint`, `pnpm typecheck` and `pnpm test` are clean; write a summary (what was built,
  how to verify manually, known gaps); then **stop and wait for approval**.
- **Dependencies:** the owner approved adding packages that are genuinely needed, but wants
  a lean tree that is easy to debug. Prefer Node built-ins or existing dependencies. Record
  every addition in `docs/decisions/0003-dependencies.md` and mention it in the milestone
  summary.
- **Ask before:**
  - changing the template meta-schema in a breaking way;
  - sending anything to a real WhatsApp number, submitting templates to Meta, or deploying;
  - weakening any principle below.
- External APIs (Meta WhatsApp Cloud / Graph API, Anthropic Messages API, Google Calendar
  API): verify request/response shapes against official docs. Never guess payloads. The
  Graph API version comes from `META_GRAPH_VERSION`, never hard-coded.
- Tests ship with every feature. Prefer small pure functions with unit tests; integration
  tests use the real Postgres/Redis from Docker Compose.
- Write a short ADR in `docs/decisions/` for every non-obvious choice.
- Tool versions are newer than most training data (TypeScript 6, ESLint 10, Vitest 5,
  pnpm 12, Turbo 2.11, Zod 4). Check the installed package's own docs before changing its
  config. Turbo ships docs in `node_modules/turbo/docs/`.

## Non-negotiable principles (spec §2)

1. **Verticals are data.** Fields, prompts, enabled tools, rules, automations, message
   templates and evals live in template packages. Code provides generic capabilities.
2. **Templates cannot execute code.** Liquid only (no side-effecting filters). Tools,
   triggers and actions come only from code registries. Only the platform owner uploads or
   publishes templates.
3. **Zero double bookings**, enforced by a Postgres exclusion constraint, not only app code.
4. **The agent never invents facts.** Prices, services, hours and policies come only from
   the business config; a price guard checks every reply that contains money amounts.
5. **No clinical or medical advice** in health verticals. Emergencies get a fixed safe reply
   plus a handoff.
6. **Tenant isolation.** Every query is scoped by `business_id` taken from the session or
   the resolved channel, never from request input. Postgres row-level security is the
   second layer.
7. **Human handoff is always available.** While a handoff is open the bot is silent.
8. **Automations are idempotent.** A rule fires at most once per subject per occurrence
   (unique key in the database).
9. **Privacy (Ley 1581 de 2012).** Consent before collecting personal data, opt-out honored
   everywhere, message text purged after the retention period, minimal data.
10. **Cost safety.** Monthly caps per business on LLM spend and marketing messages; when a
    cap is exceeded, hand off instead of spending.

## Conventions

- TypeScript strict everywhere. Use only erasable syntax (no `enum`, `namespace` or
  parameter properties). Import relative files with their `.ts` extension, and use
  `import type` for types.
- Workspace packages are named `@platform/<name>` and export their TypeScript source.
  Scripts run through Node's built-in type stripping (Node ≥ 24). There is no build
  step for packages.
- Keep functions small. Do not add an abstraction until at least two verticals need it.
- Code, comments, logs and docs are in English. Everything a patient or customer reads comes
  from templates (es-CO). Locale formatting helpers (dates, money) live in code.
- Never log tokens, API keys or full message bodies at info level. Use the shared pino
  logger, which redacts secrets.
- No secrets in code. Every new env var goes into `.env.example` and the config schema in
  `@platform/shared`.
- All business logic runs in the business timezone (Luxon), and timestamps are stored as
  UTC `timestamptz`.
- Database: Drizzle schema in `packages/db/src/schema/`. Migrations are SQL files in
  `packages/db/migrations/`: generated by drizzle-kit, or custom SQL for constraints and
  RLS.

## Commands

```sh
pnpm install
docker compose up -d        # Postgres 16 + Redis for development and tests
pnpm db:migrate             # apply migrations to DATABASE_URL
pnpm test                   # unit + integration tests (needs compose services)
pnpm lint && pnpm typecheck
pnpm format                 # prettier --write
pnpm db:generate            # drizzle-kit: schema changes → SQL migration
pnpm db:new <name>          # empty custom SQL migration (constraints, RLS)
pnpm template validate <path> [--previous <path>]   # validate a vertical template
pnpm template eval <path> [--live [--record]] [--only <ids>]   # evals; replay by default
pnpm template push <path> / eval <slug>@<v> / publish <slug>@<v>   # upload, gate run, publish
pnpm dev:api / pnpm dev:worker   # run the webhook API and the worker (watch mode)
pnpm dev:setup                   # local demo business + Meta test number (docs/whatsapp-test-number.md)
pnpm dev:admin                   # admin app on :3001 (loads the root .env)
pnpm admin:create-owner          # platform owner from OWNER_EMAIL / OWNER_NAME / OWNER_PASSWORD
pnpm test:e2e                    # build the admin + Playwright smoke test (fake Graph, scripted LLM)
```

Template authoring rules, variables, filters and eval semantics: `docs/templates.md`. Tenant-scoped DB work
always goes through `withTenant()` (`docs/decisions/0005-tenant-isolation-rls.md`). Admin
screens call `@platform/services`; each page and server action checks the session itself
(`docs/decisions/0011-admin-and-auth.md`); where to change its look: `docs/admin-ui.md`.
Next.js 16 docs ship in `apps/admin/node_modules/next/dist/docs/`: read them before
changing admin code.

## Layout

```
apps/        api (Fastify webhooks), worker (BullMQ), admin (Next.js)
packages/    core, templates, automations, scheduling, channels, llm, db, evals, shared, services
templates/   vertical template packages (YAML)
infra/       production compose, Caddy, deploy scripts (M7)
docs/        architecture, decisions, runbook
```
