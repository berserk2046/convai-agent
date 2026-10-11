# Spec review: ambiguities and risks

Written before M0, as the build prompt asks. **Section A** needs your decision; each item
gives a recommendation and the milestone it affects. **Section B** is how I'll resolve
smaller points unless you object. Resolved items move into ADRs under `docs/decisions/`.

**Status (2026-10-03): all decided.** The owner accepted every recommendation in A and B,
with two adjustments: A2 uses `PARA` instead of `BAJA` (Colombian usage), and A10 was revised
so the WhatsApp profile name never appears in customer-facing text. A6 goes in the template.

**Changes to Appendix A** that these decisions require (made in M1, reported then):

- `guardrails.opt_out_keywords`: `BAJA` → `PARA` (A2); eval `opt_out` sends `PARA`.
- `agent.dynamic_context`: add the `now.calendar` lookup table (A6).
- `booking`-related message variables fall back to the booking's name (A10).

## A. Decisions (all accepted)

**A1. Node version (M0, M7).** The spec says Node 22 LTS, but Node 22 reaches end of life
on 2027-04-30, about 7 months from now. **Recommend Node 24 LTS** for CI and production
(supported until 2028-04). **Accepted:** `.node-version` is 24, `engines` is `>=24`.

**A2. Opt-out false positives (M3, principle 9).** Whole-word matching of `BAJA` opts out
"tengo la presión baja". **Recommend:** a single-word keyword (`BAJA`, `STOP`) counts only
when it is the whole message (case, accents, punctuation and emoji ignored). Multi-word
phrases ("no me escriban") still match anywhere as whole phrases. This narrows the spec's
wording, so it needs your OK.
**Accepted, with `PARA` replacing `BAJA`** ("baja" isn't how people say stop in Colombia).
Because "para" is so common, and people send fragments ("Para" ⏎ "mañana a las 10"), the
check runs on the whole debounced batch, never on one fragment alone. Staff can re-enable
automatic messages for a contact from the admin (M5).
**Built (M5):** on the inbox conversation, after staff tick that the person asked for it.
Audited as `contact.reenable`.

**A3. Emergency during an open handoff (M3, principle 7).** The §7 order runs the emergency
check before the human-mode check, so the bot would speak during a handoff, while principle
7 says it stays silent. **Recommend:** send the emergency reply anyway, at most once per
open handoff, and escalate the handoff to `urgencia` with a staff alert.

**A4. Unknown `phone_number_id` (M2).** The spec returns 404. Meta retries non-2xx
deliveries for days, and one POST can carry entries for several numbers. **Recommend:**
answer 200, drop that entry, log a warning and raise an alert. A bad signature still gets 401.

**A5. Server-enforced booking confirmation (M3, principle 3 spirit).**
`confirmed_by_customer` is set by the model. **Recommend a two-step tool contract:**
`book`/`reschedule`/`cancel` with `confirmed_by_customer=false` returns a proposal (service,
Spanish date label, catalog price) for the model to read back. `true` is accepted only if
it matches a proposal returned in an earlier user turn. This makes `no_agenda_sin_confirmar`
structural instead of prompt-dependent, and gives the model the exact price and label to
repeat. Risk: if the model skips step one, booking takes one more turn and `agenda_simple`
fails, so the tool descriptions must make step one the obvious path.
**Alternative:** prompt plus evals only, as written. **Accepted (two-step).**
**Implemented (M3, ADR 0008):** a confirmation must match an earlier proposal's exact
details, not just its id.

**A6. Relative dates, "mañana" / "el jueves" (M3).** Add a platform variable
`now.calendar` (the next 14 days, e.g. `jueves 8 de octubre = 2026-10-08`) and use it in
odontologia's `dynamic_context`. That is a content change to Appendix A, beyond schema
fixes. **Alternative:** the runtime always appends the calendar after the rendered dynamic
context. **Accepted: in the template.**

**A7. Checking an exact time (M3).** `check_availability` can't answer "¿Puede ser a las
3?". **Recommend** an optional model-visible `around_time` ("HH:mm") that says whether that
start is free and returns the nearest alternatives. This is a code-only change to the §7
tool table, and it helps `agenda_simple` and `reprogramar`. **Implemented (M3).**

**A8. Reply-length hard cap (M3).** Cutting at exactly `max_reply_words` (60) can drop the
closing question. **Recommend:** keep the soft limit at `max_reply_words` (prompt), put the
hard cap at 1.5× and cut at a sentence boundary, and log when the cap is hit.
**Implemented (M3).**

**A9. First contact with `allow_faq_before_consent: true` (M3).**
**Recommend:**

- The first message gets `consent.message`, then the agent answers in pre-consent mode
  (booking and contact tools removed, plus an English system note telling the model to ask
  the user to accept the consent message before booking).
- An accepting message sets `consent_at`, and the agent continues with the full history, so
  `consentimiento` answers about the limpieza.
- With `allow_faq_before_consent: false`, send only the consent message, repeated at most
  once per 24 h until accepted.

**Accepted. Implemented (M3).**

**A10. Where `contact.name` comes from (M3, M4).** **Accepted (revised).** WhatsApp profile
names can be anything ("~", "Mami ❤️", a shop name), so:

- The WhatsApp profile name never appears in customer-facing text. It is stored after
  consent only as `contacts.wa_profile_name`, so staff recognize the chat in the inbox.
- `contact.name` comes only from a name the person typed, when the booking is for
  themselves. `book` gets a model-visible `for_self` boolean; a parent booking for a child
  doesn't rename the parent.
- Typed names are sanity-checked (must contain letters, trimmed, length-limited) before they
  are stored.
- Booking-related messages fall back to the booking's `subject_name`, which every booking
  has.
- `wa_templates[].variables` entries also accept `{ path, fallback }`. This is additive,
  not breaking.
- A run whose variable still resolves empty is skipped with reason `missing_variable`,
  because Meta rejects empty parameters.

**M3:** the agent part is implemented (`for_self`, name checks, profile name only after
consent). **M4:** the template-variable part is implemented.

**A11. Typed "Confirmo" (M4).** Only button taps are mapped, and the agent has no tool to
confirm a booking. **Recommend:** if the inbound text equals a quick-reply button text
(normalized) of the last template sent to this contact in the past 72 h, treat it as that
button tap.
**Implemented (M4), narrowed:** it only counts while that template is the last message
the business sent. Otherwise a "Confirmo" said to the agent's read-back of a new booking
would confirm the old reminder (ADR 0010).

**A12. Button tap during an open handoff (M4).** **Recommend:** run the data actions
(`update_booking`, `update_contact`), suppress `send_text`/`start_agent`, and notify staff.
**Implemented (M4).**

**A13. Consent for staff-created contacts (M4, M5, Ley 1581).** Reminders would reach
patients who never wrote to the bot. **Recommend:** staff must tick "el paciente autorizó el
tratamiento de datos", which stores `consent_at` and `consent_source = staff`. Automations
always apply a `has_consent` condition, like `not_opted_out`.
**M4:** automations always apply both. The staff checkbox comes with the admin (M5).
**Built (M5):** the checkbox is required when staff create a booking for a new contact, and
it is also on the inbox conversation for contacts who haven't consented. Audited as
`contact.consent`.

**A14. Price guard and `after_evaluation` services (M3).** **Recommend:** allowed amounts
are the prices of `fixed`/`from` services only. An `after_evaluation` price, even if present
in config, is never allowed. Note that eval `precio_tras_valoracion` (critical) forbids
**any** amount, so a reply that offers "una valoración de $50.000" fails it even though the
guard allows it. Keep the eval strict as written?

**A15. `notify_staff` over WhatsApp (M4).** There is no staff number in config and no staff
template in `wa_templates`. **Recommend:** in v1, an inbox item plus an admin badge.
WhatsApp to staff comes later, through an optional platform-level template.
**M4:** inbox items are rows in `staff_notifications`; the admin shows them in M5.
**Built (M5):** an unread count in the business nav and a notices panel in the inbox.
Opening a notice marks it read and goes to its conversation.

**A16. Meta template changes across versions (M4).** The `<key>_v<major>` name can't change
within a major version. **Recommend:**

- A minor version may only edit body text, through Meta's edit endpoint (subject to Meta's
  edit limits).
- Changing variables, buttons or category requires a major bump. The validator compares
  against the previous published version.

**M4:** the template sync job edits a changed body at Meta (behind
`META_TEMPLATE_SUBMISSION`).
**Upgrade flow (M5):** the owner opens a newer published version from the business page.
The screen shows the section diff and checks the business's config against the new schema,
in the same generated form. The owner fills in what the new version needs, and the upgrade
pins the version and saves the config together. Audited as `business.upgrade`.

## B. Smaller resolutions (accepted)

**Repo and tooling (M0)**

1. This directory is the repo root (it plays the role of `platform/`). Packages are scoped
   `@platform/*`.
2. Dev compose (`docker-compose.yml`) sits at the repo root, so `docker compose up -d` works
   right after cloning. The production stack goes in `infra/` (M7).
3. Outside production, `DATABASE_URL`/`REDIS_URL` default to the compose services, so the M0
   done-command works without `.env`. Production requires them.
4. TypeScript 6.0: typescript-eslint 8 supports TS < 6.1. TS 7 is out, but typed linting
   can't use it yet.
5. Internal packages export TS source. Scripts run through Node's built-in type stripping
   (≥ 24), with erasable syntax only and `.ts` import specifiers. No `tsx`.
6. Each integration test file gets its own freshly migrated database on the compose
   Postgres, so files can run in parallel. `pnpm test` runs unit and integration tests, and
   integration tests fail loudly (they don't skip) when Postgres is unreachable.
7. The Turbo `test` task is not cached, because integration tests depend on external state.
8. Redis runs with `appendonly yes` and `maxmemory-policy noeviction` (BullMQ requires the
   latter).

**Data model and tenancy (M1–M3)**

9. RLS: the owner role runs migrations and cross-tenant system jobs, which scope in code.
   Tenant work runs in transactions that do `SET LOCAL ROLE app_tenant` and
   `set_config('app.business_id', …, true)`. Policies fail closed when the setting is
   unset.
10. `bookings.resource_id` is `NOT NULL`, because NULLs never conflict in an exclusion
    constraint. Buffers stay in application code; the constraint protects the appointment
    itself.
11. The concurrency acceptance test (20 parallel `book` calls → 1 booking) uses a single
    resource of that kind. With two chairs, the correct result is 2.
12. Planned column additions:
    - `messages.processed_at`
    - `bookings.completed_at`, `cancelled_at`, `updated_at`
    - booking snapshots of `service_name` and `price_cop`
    - `contacts.consent_source`
    - a single `conversations` row per contact
    - `businesses.agent_overrides` (model choice)
13. Spanish date/time labels and `cop` formatting use explicit tables, not `Intl`. ICU
    output changes between Node versions (for example the no-break spaces in "p. m."), which
    would break snapshots and evals.

**Runtime (M2–M3)**

14. Debounce: a BullMQ deduplication job in debounce mode, keyed `business:contact`.
    **Implemented differently (ADR 0007):** BullMQ 6's `keepLastIfActive` already
    serializes per contact and schedules a follow-up for messages that arrive mid-run, so
    there's no advisory lock. A DB claim makes duplicate runs harmless.
15. Outbound idempotency: the outbound row is inserted before sending, with an idempotency
    key, so a retried job never double-sends.
16. Reactions, system and unknown message types are ignored silently. `unsupported_media`
    applies only to audio, image, video, document, sticker, location and contacts.
17. Emergency patterns are matched against both the original text and an accent-stripped
    copy, which is the safer direction.
18. Handoff reasons and replies:
    - The validator requires `error`, `price_guard`, `budget` and the emergency reason in
      `handoff.reasons`.
    - The model-visible enum leaves out `error`, `price_guard` and `budget`.
    - When the model hands off, its own text (after guardrails) is sent first, then
      `handoff_reply`.
19. The price-guard retry regenerates only the final text, with tools disabled, because
    tool side effects already happened. **M3:** a rewrite that fails with an API error
    counts as a failed guard (fallback reply plus handoff).
20. History holds the last N messages, including tool_use/tool_result pairs. Template and
    automation messages appear as assistant turns (rendered text). **Implemented
    differently (ADR 0008):** text only. State from earlier tool calls (bookings, open
    proposals) reaches the model through system block 2.
21. Time of day: morning is before 12:00, afternoon is 12:00–18:00, evening is 18:00 and
    later.
22. Prompt caching: Haiku 4.5's minimum cacheable prefix is probably larger than our system
    prompt plus tools. I'll measure with token counting in M3. Cost reports never assume
    cache hits. **M3 estimate:** about 3,000 tokens for odontologia (11,300 characters of
    system prompt and tool definitions), so caching likely doesn't apply on Haiku 4.5 yet.
    It needs a `count_tokens` check once there's an API key.
23. WhatsApp cost comes from the `pricing` block in status webhooks (billable, category),
    multiplied by a configurable rate table. Meta has billed per message since July 2025.
    **M2 finding:** a WhatsApp BSP (YCloud) reports that from 2026-10-01, service replies
    are billed at the utility rate after 1,000 free per number per month. Meta's pages I
    could fetch don't confirm it. Using Meta's `billable` flag keeps us correct either
    way, and the rate table gets a `service` entry.
    **Built (M5, ADR 0012):** a charge per delivered message, priced from the webhook's
    category. `pricing.type === "regular"` decides what is billable; Meta's current docs
    confirm that this covers service messages past the 1,000 free. The rates are Meta's
    Colombia card effective 2026-10-01.
    **Moved to M5** (ADR 0010), where `/usage` shows it. Meta's `pricing` is already
    stored on every message, so nothing is lost meanwhile.

**Templates (M1)**

24. Liquid hardening:
    - Every built-in filter except Appendix B's is removed.
    - `include`/`render`/`layout` are rejected, with no filesystem access.
    - liquidjs `parseLimit`, `renderLimit` and `memoryLimit` are set.
    - `wa_templates[].body` is never parsed as Liquid; its `{{1}}` placeholders belong to
      Meta.
25. Each Liquid string is checked against its own render context. In prompts, `booking.*`
    means the template's booking rules. In automations, it means the booking subject.
    Both contexts are documented in `docs/templates.md`.
26. Regex rule: reject `\b` next to a non-ASCII letter on **either** side, including a
    character class that contains one (`[ií]\b`).
27. `phone_co` allows an optional `+57`, then 10 digits starting with `3` (mobile) or `60`
    (landline), with spaces or dashes. `url` is `format: uri`, http(s) only.
28. Ajv strict mode may reject Appendix A's `if/then` without `type` (`strictTypes`,
    `strictRequired`). I'll report the exact tweak in M1.

**Automations (M4)**

29. A `booking.starts_in` occurrence whose fire time is before the booking was created or
    rescheduled is skipped, so no "reminder" arrives minutes after booking. Queued runs
    re-check that their occurrence key is still current; stale runs become `skipped`.
    **Implemented (M4).**
30. `run_sent` means a sent run of that rule for the same subject, and the same occurrence
    key when both rules are `starts_in`. **Implemented (M4).**
31. Meta may classify `solicitud_resena` as MARKETING. Billing and caps use
    `category_meta`. **Implemented for caps (M4)**; billing comes with B23 in M5.
    **Billing built (M5):** charges use the category Meta reports in each status webhook.

**Evals and privacy (M6, M7)**

32. `reply_contains` and `reply_contains_price` check the outbound messages of the last user
    turn. `reply_not_matches` checks every outbound message in the scenario.
    **Implemented (M6, ADR 0015).** All the assertion semantics are in `docs/templates.md`.
33. The publish gate requires a live eval run (3× per scenario). Replay recordings are for
    CI only, and any prompt or tool change invalidates them.
    **Implemented (M6, ADR 0015):**
    - Responses are filed under a hash of the request, with UUIDs normalized.
    - The gate reads the latest live run of the version's current upload.
34. Retention also strips message text from `messages.payload`/`tool_calls` and purges
    `handoffs.summary`. Any one of these alone would leak what we purge from `body`.
35. M2, M3 and M7 acceptance need your Meta test-number credentials and an Anthropic API
    key. I'll ask before any real send.

## C. Owner decisions after M3 (2026-10-08)

**C1. Noon.** Keep "12:00 m." (B13).

**C2. Public holidays (M3 follow-up, first task before M4).**

- Colombian public holidays are built in and close the business by default. That includes
  the Ley Emiliani moves to Monday and the Easter-based dates.
- Each business can choose to open on specific holidays.
- Closures stay for everything else: vacations, a chair in repair.
- Where the per-business choice lives gets settled when it's built. A platform setting on
  the business, like `limits`, fits, because every vertical needs it.
- **Built (2026-10-08, ADR 0009):** 19 holidays a year, including Ley 2578 de 2026's new
  Chiquinquirá day. The choice is `businesses.holidays.open_holidays`, a list of holiday
  keys: each holiday can be switched on (open every year) or off (closed, the default).
- **Admin (M5):** `/setup` lists the 19 holidays with their next date and an open/closed
  switch each. `/bookings` marks holidays on the grid.

**C3. Usage warning (M4, principle 10).**

- The business owner gets a notification once a month when usage reaches 90% of a monthly
  cap. That covers AI spend, and also marketing messages once M4 adds that cap.
- Reaching the cap itself still stops spending and hands off.
- The channel is whatever M4/M5 builds for staff alerts (A15).
- **Built (M4, ADR 0010):** one staff notification a month at 90%, and one at the cap
  itself, for AI spend and for marketing messages.

**C4. The agent model (2026-10-10).**

- The owner chose Claude Haiku 5.5 over spec §4's Haiku 4.5, because it costs about a
  tenth per token.
- `odontologia@1.2.0` runs on it.
- The code handles its API differences (thinking by default, append-only retries, per-request
  pricing).
- ADR 0017 has the details.
