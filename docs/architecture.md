# Architecture

Summary of spec sections 3–12 (`CLAUDE_CODE_BUILD_PROMPT.md`). The spec is authoritative.
Resolutions of ambiguous points are in `docs/spec-review.md` and `docs/decisions/`.

## Layers

| Layer                     | Contents                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Vertical templates (data) | Versioned YAML packages: `odontologia`, later `veterinaria`, `restaurante`.                      |
| Platform core (code)      | Template engine, agent runtime, tool registry, guardrails, scheduling, automations, eval runner. |
| Adapters & infrastructure | WhatsApp Cloud API, Anthropic API, calendars (built-in, Google), Postgres, Redis.                |

## Deployables

- **`apps/api`** (Fastify): WhatsApp webhooks (GET verification, POST events) and `/health`.
  A request only verifies, dedupes, enqueues and returns 200. Nothing slow happens in a
  request.
- **`apps/worker`** (BullMQ): inbound processing, automations sweeper, Meta template sync,
  booking completion, retention purge, eval runs.
- **`apps/admin`** (Next.js App Router): platform owner and business portal. Calls the
  shared service layer in `packages/*` through server actions and route handlers. There is
  no separate REST API in v1.

## Packages

| Package       | Responsibility                                                            |
| ------------- | ------------------------------------------------------------------------- |
| `shared`      | Types, errors, money/date formatting, config loading, logger              |
| `db`          | Drizzle schema, migrations, repositories, RLS helpers                     |
| `templates`   | Meta-schema, validator, Liquid renderer, template CLI                     |
| `core`        | Agent runtime, tool registry, guardrails, price guard                     |
| `scheduling`  | Availability, built-in provider, provider interface, Google provider (M8) |
| `automations` | Triggers, conditions, actions, idempotent runs, button mapping            |
| `channels`    | WhatsApp Cloud client, webhook parsing, 24-hour window logic              |
| `llm`         | Anthropic client wrapper, prompt caching, token and cost accounting       |
| `evals`       | Scenario runner, mock clock, mock channel, record/replay LLM              |

## Inbound message path

1. Meta POSTs to `api`. Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with
   `META_APP_SECRET`). Resolve the business from `metadata.phone_number_id`.
2. For each message, insert into `messages` with unique `wa_message_id`. A conflict means a
   duplicate, so skip it. Enqueue a job keyed `business_id:contact_wa_number` with a
   3-second debounce so bursts are processed together.
3. Status events (sent/delivered/read/failed) update the outbound row. Failures raise an
   alert.
4. `worker` processes the batch with the agent runtime.

Implementation details (debounce via BullMQ deduplication, the claim step, idempotent and
at-most-once sends, forward-only statuses) are in `docs/decisions/0007-inbound-pipeline.md`.

## Agent runtime (per debounced batch)

1. **Load** the business, its pinned template (parsed templates cached by slug+version), the
   channel, the contact (created if new) and the conversation.
2. **Pre-guardrails**, deterministic and run before consent, in this order:
   1. Emergency patterns → fixed emergency reply plus a handoff (`urgencia`), then stop.
   2. Opt-out keywords → set `opted_out_at`, confirm, stop. Matching is on whole words or
      phrases, case- and accent-insensitive.
   3. Conversation in `human` mode → store, notify staff, no reply.
   4. Non-text message → `unsupported_media` reply. Continue only if text is also present.
   5. Monthly LLM budget exceeded → handoff (`budget`).
3. **Consent:** on first contact, send `consent.message` once. A message matching
   `accept_patterns` sets `consent_at`. If FAQ before consent is allowed, the agent answers
   general questions, but `book`, `reschedule`, `cancel` and `update_contact` are disabled
   and no name is stored until consent is given.
4. **Request:**
   - System block 1 (cached): the rendered `system_prompt` plus `facts_template`.
   - System block 2 (not cached): the rendered `dynamic_context` (time, contact, upcoming
     bookings).
   - Messages: the last `history_messages` messages, with the batch as the final user turn.
   - Tools: only those the template enables. Template parameters are bound server-side and
     the model never sees them.
5. **Tool loop** until a final text reply. If `max_tool_calls_per_turn` is reached, hand off
   (`error`).
6. **Post-guardrails:**
   - Price guard: every money amount must equal a catalog price. On a violation, retry once
     with a corrective note. If it fails again, send `fallback_reply` and hand off
     (`price_guard`).
   - Reply-length cap.
7. **Send** through the channel. The agent always replies inside the 24-hour window.
8. **Log** tool calls, tokens (input, output, cache read/write) and cost, and write
   `usage_events`.

Implementation details are in `docs/decisions/0008-agent-runtime.md`:

- the hand-written tool loop;
- text-only history plus runtime notes;
- the server-enforced two-step confirmation;
- spend metering;
- the price-guard rewrite.

### Tool registry

`lookup_catalog`, `check_availability`, `book`, `find_bookings`, `reschedule`, `cancel`,
`handoff`, `update_contact`. All tools are business-scoped, validate input with Zod and
return compact JSON. Times are ISO strings plus a Spanish label ("jueves 8 de octubre,
3:00 p. m."). Booking writes catch the exclusion violation and return a typed `SlotTaken`.

## Scheduling

- **Provider interface:** `getBusy`, `createEvent`, `updateEvent`, `deleteEvent`. The
  built-in provider (bookings + closures) is the source of truth. Google (M8) adds busy
  blocks and mirrors bookings.
- **Availability:** for each resource of `resource_kind`, start from business `hours`
  intersected with the resource schedule. Subtract closures, active bookings (+ buffer) and
  provider busy blocks. Candidates sit on a 15-minute grid where `[start, start + duration +
buffer)` fits. Apply `min_notice_hours`, `max_days_ahead` and the `time_of_day` filter,
  then offer `slots_to_offer` options spread across days and times.
- **Durations:** from the catalog item (`duration_from: service`), or
  `booking.fixed_duration_min` (`duration_from: fixed`).
- **Completion job** (every 10 minutes): `pending`/`confirmed` bookings whose
  `ends_at + 60 min < now` become `completed` and emit `booking.completed`.
- **Double-booking guard:** a gist exclusion constraint on
  `(resource_id, tstzrange(starts_at, ends_at, '[)'))` for `pending`/`confirmed` bookings.

## Automations

- **Triggers:** `booking.created|rescheduled|cancelled` (immediate),
  `booking.starts_in(offset)`, `booking.completed(offset)`,
  `contact.date_field(field, offset, at_local_time)`, `conversation.inactive(duration)`,
  `schedule(cron)`. Each trigger defines a subject and an occurrence key.
- **Sweeper** (every minute, 2-hour lookback): finds due subjects, then
  `INSERT … ON CONFLICT DO NOTHING` into `automation_runs` with the unique
  `(automation_id, subject_type, subject_id, occurrence_key)`. Only newly inserted runs are
  enqueued. Event triggers insert runs directly.
- **Conditions** are evaluated at send time: field comparisons (`eq`, `in`, `exists`,
  `not_exists`) and the built-ins `not_opted_out` (always on), `quiet_hours` (postpone to
  08:00), `no_future_booking` and `run_sent`.
- **Actions:** `send_template`, `send_text` (24-hour window only), `update_booking`,
  `update_contact`, `notify_staff`, `start_agent`.
- **Button replies:** the quick-reply payload is `<rule_key>:<run_id>:<payload>`, which
  runs that rule's `on_button.<payload>` actions.
- **Meta templates:** submitted per WABA as `<key>_v<major>`. Status and category come from
  webhooks, and billing uses the category Meta reports. A non-approved template blocks its
  automation.

## Template system

- **Top-level keys:** `manifest`, `config_schema`, `contact_fields?`, `consent`, `booking`
  (needed if booking tools are enabled), `agent`, `guardrails`, `wa_templates?`,
  `automations?`, `evals`, `sample_config`, `eval_fixtures?`.
- **`_config` suffix:** a template value can come from a business config field, for
  example `min_notice_hours_config: booking_notice_hours`.
- **Platform schema types:** `platform:weekly_hours`, `money_cop`, `duration_min`,
  `phone_co`, `url`.
- **UI hints:** `x-ui` keys for the admin form generator. `x-ui` is registered as an Ajv
  keyword so strict mode stays on.
- **Defaults:** Ajv runs with `useDefaults: true`, and the defaulted config is what gets
  stored.
- **Liquid:** strict variables, `lenientIf`, strict filters, no filesystem, and only the
  Appendix B filters (`cop`, `join`, `default`, `upcase`, `downcase`, `date`).
- **Validation rules** (spec §10, 1–10): YAML and meta-schema; semver plus uniqueness; valid
  JSON Schema; `sample_config` valid; every Liquid string renders strictly; tools exist and
  their params validate; triggers, actions, template keys, buttons and field paths exist;
  Meta template body rules; evals reference real services and fixtures; regexes compile
  with `iu` and never put `\b` next to non-ASCII letters.
- **Lifecycle:** upload → validate → evals → publish gate (100% of critical evals, ≥ 90%
  overall) → businesses pin a version → optional upgrade with a diff and config
  re-validation.
- **CLI:** `pnpm template validate|eval|push|publish`.

## Evals

- **Scenarios:** `id`, `critical`, `clock?`, `fixtures?`, `consent?`, `turns` (`user:` and
  `expect_tool:`), and `assert`.
- **Assertions:** `tool_called`, `no_tool`, `booking_created`, `bookings_count`, `handoff`,
  `no_handoff`, `reply_contains`, `reply_not_matches`, `reply_contains_price`, `judge`
  (Sonnet).
- **Runtime:** the real agent runtime and tools, a mock clock (default
  `2026-10-05T09:00:00-05:00`), a mock channel and a throwaway database. LLM calls run live
  or through record/replay.
- **Nightly live runs:** 3 runs per scenario; a critical scenario must pass all 3. CI runs
  replay mode on every PR.
- **Playground:** chat with any template from the admin, showing tool calls, tokens and
  cost.

## Admin app

- **Platform owner:** `/templates`, `/businesses` (create, upgrade, channel, activation,
  impersonate), `/playground`, `/usage`.
- **Business admin:** `/setup` (RJSF form from `config_schema`, resources, closures,
  consent), `/automations`, `/inbox`, `/bookings`, `/reports`.
- **Business staff:** `/inbox` and `/bookings`.
- **Language:** Spanish labels for business users; English is fine on platform-owner
  screens.

## Data model

See spec §6 for the full table list. All business-owned tables have
`business_id uuid not null` and RLS policies. All timestamps are `timestamptz`. Planned
additions are listed in `docs/spec-review.md` §B.
