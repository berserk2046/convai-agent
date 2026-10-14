# Handoff for M7 (pilot hardening and deploy)

Written 2026-10-13, at the end of M6. M7 starts only when the owner asks. Read this
first, then `CLAUDE.md`, then spec §13 and §15 (M7) in `CLAUDE_CODE_BUILD_PROMPT.md`.

## 1. Where the project is

**Milestones:**

- M0–M6 are done, approved and on `main`.
- M6 was the evals, the publish gate and the playground (ADR 0015, ADR 0016). It also
  moved the dental agent to Claude Haiku 5.5 (ADR 0017) and added the owner's behavior
  rules (ADR 0018).

**Git:**

- `main` = `8761f4c` (the last code commit), plus the commit that adds this handoff.
  `origin/main` = `d41dd13`; the owner pushes from their own terminal.
- Milestone branches `m4-automations`, `m5-admin`, `m6-evals` and `m6-owner-rules` all
  point into `main` and can be deleted once pushed.
- Workflow: work on a milestone branch, commit only when the owner asks, then
  `git merge --ff-only` into `main`. End commit messages with the Co-Authored-By line from
  the session's instructions.

**Quality bar at handoff:**

- `pnpm test`: 726 tests pass (unit and integration, real Postgres/Redis from Docker
  Compose, fakes for Meta and Claude).
- `pnpm test:e2e`: the Playwright smoke test passes. It builds the admin and walks the
  whole owner and business flow, using a fake Graph API, a fake Anthropic API
  (`apps/admin/e2e/fake-anthropic.ts`) and a scripted LLM.
- `pnpm lint`, `pnpm typecheck` and `pnpm format:check` are clean.
- CI (`.github/workflows/ci.yml`) runs those checks, then replays every template's
  recorded evals.
- `evals-nightly.yml` runs live evals, but only once the owner adds the
  `ANTHROPIC_API_KEY` repository secret (not added yet; about $0.065 a run).

**The dental template:**

- It is `templates/odontologia/template.yaml` at `1.2.0`, on `claude-haiku-5-5`, with 18
  eval scenarios (14 critical).
- The last live run passed 54/54, gate passed. Its recordings,
  `templates/odontologia/eval-recordings.json`, replay 18/18.
- Any change to the prompt, tools or tool descriptions makes the recordings stale. Run
  `pnpm template eval templates/odontologia --live --record --max-cost 0.25`, which is
  paid, so ask first (see §4).

## 2. What M7 must deliver (spec §15) and what exists

> **M7 — Pilot hardening and deploy.** Production Docker images, Caddy with HTTPS, deploy
> script for a single VPS, backups, Sentry, alerts, retention job, usage report, runbook in
> `docs/runbook.md`. Done when: staging deployed and working on the test number; runbook
> covers token expiry, template rejection, provider outage, restore from backup.

| Item                   | State at handoff                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production images      | None. There is no `infra/` directory yet (spec review B2 puts the production stack there).                                                                                                                        |
| Caddy, HTTPS           | None.                                                                                                                                                                                                             |
| Deploy script          | None.                                                                                                                                                                                                             |
| Backups                | None. Spec §13: daily `pg_dump` to off-server storage, plus a documented restore.                                                                                                                                 |
| Sentry                 | Not wired. `SENTRY_DSN` is in `.env.example` but not in any env schema. The hook is `alert(logger, code, details, msg)` in `packages/shared/src/logger.ts`, which logs at error level with an `alert` field.      |
| Alerts                 | The codes exist (list below). The spec's "booking tomorrow without a reminder run" alert is **missing**.                                                                                                          |
| Retention job          | **Not built.** `RETENTION_DAYS=180` is in `.env.example` but not in any env schema. Spec review B34 says what it must purge.                                                                                      |
| Usage report           | `/usage` (M5, ADR 0012) shows cost per business per month vs plan price, LLM vs WhatsApp. Ask the owner whether "usage report" in M7 means more, such as a monthly export or an email.                            |
| Runbook                | None. `docs/runbook.md` must cover token expiry, template rejection, provider outage and restore from backup.                                                                                                     |
| Staging on test number | **Blocked**: the owner's Meta business account isn't sorted out, so there's no test number (`docs/whatsapp-test-number.md`). Deploy and verify everything else, and leave the WhatsApp check for when Meta works. |

**Alert codes in the code today:**

| Area           | Codes                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| WhatsApp       | `wa_send_<kind>`, `wa_delivery_failed`, `wa_no_channel`, `wa_unknown_phone_number`                          |
| Meta templates | `wa_template_sync_failed`, `wa_template_name_taken`                                                         |
| Automations    | `automation_failed`, `automation_event_failed`, `automation_sweep_failed`                                   |
| Worker         | `inbound_job_failed`, `maintenance_job_failed`                                                              |
| Agent          | `handoff_emergency`, `llm_budget_reached`, `llm_failed`, `llm_model_unpriced`, `price_guard`, `tool_failed` |

Sandboxes (evals and the playground) capture their own logs, so their alerts never reach
the process log (`packages/evals/src/logs.ts`). Keep it that way when Sentry is wired.

**Retention (spec review B34).** Null `messages.body` older than `RETENTION_DAYS`, and also
strip the message text out of `messages.payload` (the raw Meta message), `messages.tool_calls`
and `handoffs.summary`. Keep the metadata.

- Tenant data: run it as a system job (owner role, scoped in code) like the sweeper, or per
  business with `withTenant`.
- Also decide whether `playground_sessions.entries` and `eval_runs.results` are covered.
  They hold the owner's test text and synthetic data, not customers' data.

## 3. Facts the code imposes on deployment

- **Node ≥ 24.7** (`.node-version` is 24). Every package and app is TypeScript source run by
  Node's type stripping, with no build step: `node src/main.ts` for api and worker. Images
  must contain the workspace source: `packages/*/src`, `packages/db/migrations`,
  `templates/`, and the `node_modules` from `pnpm install --frozen-lockfile`.
- **Admin (Next.js 16.3.8, Turbopack):** `next build`, then `next start --port 3001`, run
  from `apps/admin`.
  - **Don't use `output: "standalone"`.** `packages/db/src/migrate.ts` finds the migrations
    folder through `import.meta.url`, which Turbopack rewrites to the original source path.
    The source tree must exist at runtime, because the admin migrates playground scratch
    databases. This was checked with a production build in M6; see the comment in
    `migrate.ts`.
  - `next.config.ts` loads the root `.env` only if the file exists. In containers, pass the
    environment directly.
  - Read `apps/admin/node_modules/next/dist/docs/` before changing admin config.
- **Ports:**
  - The API listens on `PORT` (default 3000), and `HOST` defaults to 127.0.0.1, so set
    `HOST=0.0.0.0` in containers.
  - The admin listens on 3001.
- **Routes:**
  - API: `GET` and `POST /webhooks/whatsapp` (the URL configured in Meta), and
    `GET /health`, which checks the database and Redis.
  - Admin: everything else. `/inbox/events` is a server-sent event stream: **Caddy must
    not buffer it** (`flush_interval -1`; ADR 0013, the carry-over in `CLAUDE.md`).
  - Login rate limiting reads the first `X-Forwarded-For` entry, which Caddy sets. Cookies
    are `Secure` when `NODE_ENV=production`.
- **Database role:**
  - Migrations create role `app_tenant` and grant it to the connecting role, which needs
    CREATEROLE (migration 0002). RLS fails closed.
  - Eval runs and playground chats create scratch databases (`eval_*`, `play_*`), which
    needs **CREATEDB** (ADR 0015).
  - The compose superuser has both. A restricted role must get them.
  - The worker's hourly `cleanup-sandboxes` job drops leftover scratch databases.
- **Migrations:** `pnpm db:migrate` takes an advisory lock, so it's safe if two containers
  run it at once. Run it before starting the apps. There are 15 migrations as of M6
  (`0014_evals_playground` was the last).
- **Redis:** `appendonly yes` and `maxmemory-policy noeviction` (BullMQ needs both); see the
  root `docker-compose.yml`.
- **Worker processes:**
  - the inbound queue and the automations queue;
  - repeatable maintenance jobs: `complete-bookings` every 10 minutes, `sweep-automations`
    every minute, `sync-wa-templates`, and `cleanup-sandboxes` hourly;
  - the eval loop, which polls `eval_runs` every 5 seconds, claims one run at a time, and
    fails runs whose heartbeat is older than 15 minutes.
- **Environment by app** (schemas in `packages/shared/src/env.ts`):
  - **api:** `DATABASE_URL`, `REDIS_URL`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
    `INBOUND_DEBOUNCE_MS`, `HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`.
  - **worker:**
    - `DATABASE_URL`, `REDIS_URL`, `META_GRAPH_VERSION`, `META_GRAPH_BASE_URL`,
      `ENCRYPTION_KEY`;
    - `INBOUND_HANDLER` (`agent` requires `ANTHROPIC_API_KEY`), `INBOUND_DEBOUNCE_MS`,
      `ANTHROPIC_API_KEY`, `LLM_BUDGET_USD_MONTH`, `JUDGE_MODEL` (must have a price);
    - `META_TEMPLATE_SUBMISSION` (**keep `off`**; the owner said no until Meta works),
      `MARKETING_MSGS_MONTH`.
  - **admin:** `DATABASE_URL`, `ENCRYPTION_KEY`, `META_GRAPH_VERSION`,
    `META_GRAPH_BASE_URL`, `MARKETING_MSGS_MONTH`, `SESSION_SECRET` (32+ characters;
    changing it logs everyone out), `ANTHROPIC_API_KEY` (playground; without it the
    playground says it's off).
  - **CLI** (`pnpm template …`): `DATABASE_URL`, `ANTHROPIC_API_KEY` (live only),
    `EVAL_LLM`, `JUDGE_MODEL`.
  - **To add in M7:** `SENTRY_DSN`, `RETENTION_DAYS` and probably `PUBLIC_BASE_URL`. Add
    each to its schema and `.env.example` (CLAUDE.md rule).
  - `ENCRYPTION_KEY` (32 bytes, base64) seals the channel tokens; losing it loses them, so
    back it up separately from the database.
- **First setup on a fresh server:**
  1. `pnpm db:migrate`.
  2. `pnpm admin:create-owner`, with `OWNER_EMAIL`, `OWNER_NAME` and `OWNER_PASSWORD` in
     the environment.
  3. `pnpm template push templates/odontologia`.
  4. A stored live gate run, `pnpm template eval odontologia@1.2.0`: paid, about $0.065,
     ask first. Or use **Run evals** in the admin, where the worker runs it.
  5. `pnpm template publish odontologia@1.2.0`.
  6. Create the business in the admin and connect its channel.

  `pnpm dev:setup` refuses `NODE_ENV=production` and skips the gate; it's for local
  development only.

## 4. The owner's rules (keep following them)

- **Money:**
  - The Anthropic account had **$5** of credit. **$0.294 is spent; about $4.71 is left**,
    and the owner wants part of it kept for M7.
  - Anything that calls the Claude API for money needs the owner's explicit OK first, with
    an estimate. Report the actual cost afterwards and keep a running total.
  - Free runs ($0) need no asking: `pnpm test`, `pnpm test:e2e`, replays, `count_tokens`,
    static checks. No automated test reaches the real API (checked in M6).
  - Live CLI eval runs always pass `--max-cost`.
- **Reference costs** (Haiku 5.5, measured):
  - an agent model call is about $0.0005–0.001;
  - a playground message is about $0.001;
  - a Sonnet 5.5 judge call (low effort) is about $0.0015;
  - a full live eval run of odontologia (18 × 3) is about $0.065.
- **Ask before:**
  - **deploying** (staging included; the owner must also supply the VPS, the domain and
    the backup storage);
  - sending anything to a real WhatsApp number;
  - submitting templates to Meta;
  - adding the nightly-eval secret;
  - a breaking meta-schema change;
  - weakening any principle.
- **Agent behavior the owner wants** (ADR 0018), and its rules for future verticals:
  - When the asked day has nothing free, offer 2–3 nearby days with times in the same part
    of the day, in the same reply, without asking.
  - Never say an earlier answer was given without checking, and never apologize for it.
  - Dates past `max_days_ahead` aren't open yet; never call them full.
  - Professional, Colombian Spanish, no Markdown (WhatsApp).
- **Working style:**
  - The owner wants short progress updates during long work.
  - Plain language, cost tables before paid steps, root causes rather than prompt patches
    (read their playground transcript in `playground_sessions` first).
  - Commit only when asked.
  - At the end of the milestone: lint, typecheck and test clean, a summary, then stop for
    approval.

## 5. Open questions for the owner at the start of M7

1. **VPS:** provider, size, and OS; is SSH access given to the session, or does the owner
   run the deploy script?
2. **Domains:** for example `api.<domain>` (Meta's webhook) and `admin.<domain>`, or one
   host with path routing. Caddy needs DNS pointed first.
3. **Backup storage:** an S3-compatible bucket (Backblaze B2, AWS S3…) or another server;
   retention of the backups themselves.
4. **Sentry:** is there an account? (It's optional in the spec; without a DSN, alerts stay
   in the logs.) Where should alerts reach the owner (email, Telegram…)?
5. **Usage report:** is `/usage` enough, or a monthly export or email?
6. **Staging and production:** one VPS with two stacks, or staging only until a pilot
   clinic exists?
7. **Nightly live evals:** add the repository secret now, run weekly instead, or wait?

## 6. Local environment state (owner's machine)

- Docker Compose runs `agent-platform-postgres-1` (Postgres 16) and
  `agent-platform-redis-1`.
- The dev database `platform` is fully migrated (15 migrations).
  - Templates: odontologia `1.0.0` and `1.1.0` are published, both on Haiku 4.5. `1.2.0`
    is a **draft** with the latest prompt and 18 evals, on Haiku 5.5.
  - Businesses: "Clínica Dental Demo" on `1.0.0`, status `setup`. Moving it to Haiku 5.5
    means publishing 1.2.0 (gate run, paid) and upgrading it.
  - Playground: two sessions, one closed (on 1.1.0) and one active (on 1.2.0, the owner's
    10-message test chat that led to ADR 0018).
- `.env` has the owner's `ANTHROPIC_API_KEY` (never print it), `JUDGE_MODEL=claude-sonnet-5-5`
  and `EVAL_LLM=replay`. There are no Meta credentials (the test number is blocked).
- Three old `test_<hex>` databases left by earlier sessions are harmless; drop them if you
  like. The new naming is `test_<base36 time>_<hex>`.

## 7. Known quirks

- Next logs "The destination stream closed early" when a re-render is abandoned.
  It's harmless (ADR 0013), and it also shows during the e2e.
- Live evals aren't deterministic. The gate needs 3/3 on critical scenarios; look at the
  transcript before blaming the model (two of M6's failures were platform or judge bugs).
- The judge's output schema must keep `reason` before `pass` (ADR 0018).
- The compiled-template cache is keyed by row id, not slug@version (ADR 0015 §6): scratch
  databases install their own copies.
- Tool call history reaches the model only through the recap in system block 2 (ADR 0018);
  the message history itself is text only (ADR 0008).
