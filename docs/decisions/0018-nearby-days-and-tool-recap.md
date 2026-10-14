# 0018 — Nearby days, the booking window, and the recap of earlier checks

Status: accepted (owner, 2026-10-11)

## Context

The owner tested the dental agent in the playground (10 messages, odontologia 1.2.0 on
Haiku 5.5). Three things went wrong:

1. **The agent asked instead of offering.** No times were free on the asked day, and the
   agent replied "¿quiere que busque otros días?". The owner wants 2 or 3 nearby days with
   free times in the same part of the day, offered right away.
2. **The agent said December was full.** It wasn't: 10 December is past `max_days_ahead`
   (45 days), so bookings for it hadn't opened yet. `check_availability` returned the same
   "nothing free" it returns for a full day, so the model couldn't tell the two apart.
3. **The agent apologized for not checking, when it had checked.** It kept replying "le
   debo una corrección: antes respondí sin revisar el sistema", with a tool call behind
   every answer.
   - The cause is ADR 0008: the conversation history is text only. On a later turn the
     model saw its earlier replies but not the checks behind them, so it concluded it had
     answered without checking.
   - The owner finds this unprofessional and wants it gone.

## Decision

1. **`check_availability` returns `nearby_days` when nothing is free on the asked dates.**
   - It returns up to 3 days, each with up to 2 times, closest first. Ties go to the
     earlier day; the list is shown in date order.
   - It looks 7 days before and 14 days after the asked dates, within the booking window.
   - The times are in the same part of the day as the request: its `time_of_day`, or the
     one `around_time` falls in.
   - This is code (`nearbyDays` in `@platform/scheduling`) because every vertical needs it.
     The template's prompt tells the model to offer the days without asking first.
2. **`booking_window` appears when the asked dates are later than `max_days_ahead`.** It
   gives the last bookable date and its label, with a note that those dates aren't full.
   `nearby_days` then holds the last days of the window. The prompt says to explain the
   limit and never call such a date full.
3. **Each turn recaps the earlier checks.** System block 2 (not cached) lists the last 6
   tool calls of earlier turns, as stored with each agent reply (`messages.tool_calls`).
   - Results are kept and the tools' guidance (`note`, `next_step`) is left out. Each line
     is clipped to 500 characters.
   - The prompt also says that earlier answers came from real checks: never apologize for
     not checking.
4. **Three new eval scenarios.**
   - `sin_cupo_ofrece_otros_dias` (critical): Sunday is closed, and nearby days must be
     offered without asking.
   - `no_se_autocorrige` (critical): a follow-up question about the same day, with no
     "le debo una corrección".
   - `fecha_fuera_de_plazo`: a date past the window.

## Consequences

- The recap adds about 300–900 uncached input tokens to each request, under $0.0001 a
  request on Haiku 5.5. It also saves calls: the model no longer repeats lookups it can
  see.
- Like the rest of system block 2, the recap shows tool results (dates, names) to the
  model only. Retention purges `tool_calls` with the message text (spec review B34).
- The eval recordings must be re-recorded after this change. That needs one live run.

## First live run (2026-10-11)

18 scenarios × 3 runs passed 49 of 54, for $0.065:

- **`no_se_autocorrige` passed 3 of 3**, and all the earlier scenarios stayed green.
- **`sin_cupo_ofrece_otros_dias` failed 3 of 3, through a judge bug.** Every reply did what
  the owner asked, and the judge's reasons said so, yet it returned `pass: false`. The
  verdict field came before the reason in the output schema, so at low effort the model
  committed to a verdict before reasoning. Now `reason` comes first and the system prompt
  asks for a verdict that agrees with it. The rubric now accepts "closed on Sundays" as
  "can't be booked".
- **`fecha_fuera_de_plazo` failed 2 of 3.** The agent computed the 45-day limit itself and
  searched broad November ranges, so it offered early-November dates. The prompt now says
  to check the asked date itself, which returns the last days of the window.

The next full run, with the fixed judge and prompt, passed **54 of 54, with the gate
passed**, for $0.065. The recordings come from it, and replay passes 18 of 18.
