# 0016 — The playground

Status: accepted (M6)

## Context

Spec §11: the platform owner chats with any template, using its `sample_config` or a real
business's config, and sees tool calls, tokens and cost per turn, without sending anything
to WhatsApp.

The agent needs a database to work in. It books, records proposals, opens handoffs and
writes usage. With a real business's config, none of that may touch the business's real
calendar, contacts or spend.

## Decision

1. **Each session gets its own scratch database** (`play_<time>_<random>`, ADR 0015).
   - A session holds one sandbox business and its sandbox customer.
   - The sandbox is built from the chosen template version, plus either `sample_config`
     with the template's eval resources, or the business's config, active resources,
     closures, holidays and timezone.
   - The business's bookings and contacts are never copied: they are personal data, and
     the playground has no need for them.
   - A business's config is validated against the chosen version first, so the owner can
     try an upgrade before doing it.
2. **The admin process runs turns as server actions.**
   - A turn takes a few seconds, the same as the agent in the worker.
   - The admin gets `ANTHROPIC_API_KEY`. Without it, the playground says it is off and
     everything else works.
   - Each request opens the session's database, runs migrations (cheap when there is
     nothing new, and it covers a deploy mid-session), runs the turn through the same
     sandbox code as evals, and closes the database.
3. **The transcript lives in the platform database.**
   - The `playground_sessions` table holds each turn as an entry: the replies, tool calls
     with their inputs and results, tokens, cost, models, booking events, captured warnings,
     and a snapshot of the sandbox state.
   - Pages read only this row; they never open the scratch database.
   - A `busy_since` claim allows one turn at a time per session. A claim older than 3
     minutes belongs to a request that died, and the next message takes it over.
4. **Spend shows in the session, not in business usage.**
   - Each turn's cost appears on the turn, and the session shows its total.
   - It isn't a business's usage: no business ran it.
   - Sandboxes have no AI budget cap; the owner sees the cost as it accrues.
5. **Lifetime.**
   - "End chat" drops the database, and the transcript stays readable until it is deleted.
   - The worker's hourly cleanup closes sessions idle for 24 hours. It also drops play
     databases that no active session uses (after 1 hour of grace) and eval databases older
     than 6 hours.
6. **Owner only.** Every function checks the owner role, and any owner can see every
   session. Starting a session is audited as `playground.start`.

## Consequences

- Automations don't run in the playground, so reminders and review requests can't be
  tried there. Templates' automation messages have previews on `/automations`.
- The calendar in a sandbox built from a real business starts empty. It doesn't show the
  business's real availability, only its hours, resources and closures.
- The playground's clock is the real one. To reproduce an eval scenario, open its
  transcript in the eval report.
