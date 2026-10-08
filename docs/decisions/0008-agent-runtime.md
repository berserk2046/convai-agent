# 0008 — Agent runtime: tool loop, confirmation, guardrails, spend

Status: accepted (M3)

## Sources

Request and response shapes come from the Anthropic Messages API reference and the types of
`@anthropic-ai/sdk` 0.132.0: tool use, `tool_choice: { type: "none" }`, `cache_control`,
stop reasons including `refusal`, the `usage` fields and the SDK's error classes. Prices
and the prompt-caching minimums come from the claude-api reference cached on 2026-09-25.
None of this has run against the live API yet, because there is no API key (see "Open").

## Decision

1. **Manual tool loop** (`core/src/agent/loop.ts`), not the SDK's beta tool runner. Every
   call is validated with Zod and scoped to the business. Calls are capped at
   `max_tool_calls_per_turn` (then a handoff with reason `error`). A handoff ends the turn.
   The price-guard rewrite re-asks with tools listed but `tool_choice: none`.
2. **History is text only** (changes spec review B20). Stored messages become alternating
   user/assistant turns, with the batch as the last user turn. Tool calls of earlier turns
   are not replayed. What the model needs from them goes into system block 2 under
   `[Runtime notes]`, in English: upcoming bookings, open proposals with their ids,
   consent state, and a business message that opened the conversation (e.g. a reminder).
   Reasons:
   - old `tool_use`/`tool_result` pairs must match exactly or the API rejects the request;
   - proposals expire anyway;
   - the prompt stays smaller.
3. **Two-step confirmation (A5)**, enforced by the server with the `booking_proposals`
   table:
   - A call without confirmation records a proposal: the action, its details, the batch's
     last message id as `turn_id`, and a 2-hour expiry. It returns a summary (service,
     Spanish date label, catalog price) for the model to read back.
   - A confirmed call goes ahead only if an open proposal has **exactly the same details**:
     - `book`: service, start, normalized name and party size;
     - `reschedule`: booking and new start;
     - `cancel`: booking.

     `proposal_id` is only a hint. Matching by id alone would let a confirmation carry over
     to another time, service or person.

   - The proposal must come from an earlier batch: its `turn_id` can't be any message of
     the current batch. A retried batch includes the messages of the attempt that failed,
     and that attempt's proposal never reached the customer.
   - The proposal is consumed in the same transaction as the booking change, so one
     confirmation acts at most once. A repeat returns `already_done`.
4. **Consent (A9).**
   - `contacts.consent_requested_at` records when the consent message went out.
   - With FAQ allowed before consent, the consent message is sent once. The agent then
     answers without `book`, `reschedule`, `cancel` and `update_contact`, plus a runtime
     note.
   - Without FAQ, only the consent message goes out, at most once per 24 hours.
   - An accepting message unlocks the tools within the same turn.
5. **Emergencies (A3).** They open a handoff, or raise the reason of an open one to the
   emergency reason. They reply at most once per open handoff
   (`handoffs.emergency_replied_at`).
6. **Price guard (principle 4).**
   - Allowed amounts are catalog prices of type `fixed` or `from` (A14).
   - Recognized formats: `$` amounts, numbers with thousands separators, "X mil",
     "X millones" and "Xk". Amounts are rounded to whole pesos, since 4.1 × 1,000,000 is
     not exact in floating point.
   - One rewrite with tools off. If the rewrite still invents an amount, or fails (API
     error), the customer gets `fallback_reply` and a `price_guard` handoff opens. The
     turn's tools already ran, so retrying the whole turn is not an option.
7. **AI errors.** Retryable errors (connection, 408, 409, 429, 5xx, 529) are rethrown while
   the job has attempts left, so BullMQ retries the batch. On the last attempt, or for any
   other error, the turn hands off with reason `error`. Replaying a turn is safe: proposals
   of the same batch are reused, and consumed ones return `already_done`.
8. **Spend (principle 10).**
   - A metering wrapper adds up every response's usage. The total is written to
     `usage_events` even when the turn fails midway, then attached to the first reply.
   - The monthly cap is the business's `limits.llm_usd_month`, else `LLM_BUDGET_USD_MONTH`
     (15 USD). It is checked before the model runs; over the cap, the turn hands off with
     reason `budget`.
   - A model missing from `MODEL_PRICES` is refused (handoff), because its spend couldn't be
     capped.
   - The model is the business override or the template's required `agent.model`. The
     spec's `DEFAULT_MODEL` env var could never apply, so it was removed.
9. **Prompt caching.** System block 1 carries `cache_control: ephemeral`, and every turn
   logs `cache_read`.
   - For odontologia, the prefix is about 3,650 characters of system prompt plus 7,650 of
     tool definitions. That's roughly 3,000 tokens, an estimate rather than an API count.
   - This is likely under Haiku 4.5's 4,096-token minimum, so caching probably does nothing
     there yet.
   - Cost reports use only what the API reports.
10. **Reply order.** `messages.created_at` defaults to `clock_timestamp()`. With `now()`,
    every reply inserted in one transaction got the same time, so a consent message and the
    agent's answer could go out in either order.
11. **Booking events** (`booking.created`, `rescheduled`, `cancelled`, `completed`) go to an
    `EventSink`. Until M4's automations consume them, the sink logs them.
    - A maintenance job scheduler (BullMQ) marks bookings completed 60 minutes after they
      end, every 10 minutes.
    - Calendar sync goes through the `SchedulingProvider` interface (built-in no-op until
      M8).
12. **Scheduling** (`@platform/scheduling`) is pure.
    - Slots fall on a 15-minute grid in the business timezone, with start + duration +
      buffer inside opening hours.
    - Existing bookings are extended by the buffer. Minimum notice and `max_days_ahead`
      apply.
    - Closures with no resource apply to the whole business. For now holidays are entered
      as closures. Built-in Colombian holidays are decided and come next (spec review C2).
    - Offers are spread across days and times. `around_time` (A7) returns the exact time
      when free, plus the nearest alternatives.

## Consequences

- `no_agenda_sin_confirmar` holds even if the model ignores the prompt. The price is
  `agenda_simple` taking one extra tool call when the model skips step one.
- Customers never get an amount outside the catalog, but correct replies are sometimes
  rewritten (e.g. "1.000 pasos" reads as money).
- Until a live run, cache hit rates and real token counts are unknown.

## Open

- Live check with an Anthropic key: `count_tokens` for the prefix, a cache hit on the second
  turn, and the full M3 eval scenarios.
- Built-in Colombian public holidays, with a per-business choice to open on them (spec
  review C2, decided 2026-10-08, not built yet).
