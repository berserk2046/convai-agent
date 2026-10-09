# 0010 — Automations engine: runs, sweeper, buttons, Meta templates

Status: accepted (M4)

## Sources

Meta shapes were checked against Meta's WhatsApp docs, fetched 2026-10-08:

- **Webhook reference:** `message_template_status_update` and `template_category_update`.
  The recorded examples are in `packages/channels/fixtures/template-*.json`.
- **Template management:**
  - list: `GET /{waba}/message_templates`, with fields and cursor paging;
  - edit: `POST /{template-id}`. The new components replace all the old ones. Only
    APPROVED, REJECTED or PAUSED templates can be edited;
  - the error for an existing name and language: code 100, subcode 2388024.
- **Template creation:** the utility-template page and the overview. The request takes
  `parameter_format: "positional"` and a body `example.body_text: [[…]]`. The response is
  `{ id, status, category }`.
- **BullMQ 6.3:** a custom job id can't contain `:`, checked in its source.

Meta's examples use lowercase component types and categories in creation requests, and
uppercase ones in edit requests and list responses. We send the category in lowercase, as
the creation example does, and uppercase components everywhere. That keeps comparisons with
what Meta lists simple. The first live submission will confirm both forms.

## Decision

1. **Package `@platform/automations`.** It depends on core (sending, the agent's hook
   types) and db. Core never imports it: the agent receives a `ButtonHandler`, and booking
   tools receive an `EventSink`. The worker wires both.
2. **Runs** (`automation_runs`, unique on rule + subject + occurrence key; principle 8):
   - inserted with `ON CONFLICT DO NOTHING`; only new rows are enqueued;
   - status `scheduled` → `sent` | `skipped` | `failed`. `sent` means the action was
     carried out, whatever the action is. `reason` holds a short code: `opted_out`,
     `no_consent`, `stale_occurrence`, `condition:<field>`, `run_not_sent`,
     `future_booking`, `template_not_approved`, `marketing_cap`, `missing_variable`,
     `window_closed`, `needs_customer_message`…;
   - a run ends exactly once (`finishRun … WHERE status = 'scheduled'`). Messages carry
     the key `run:<id>`, so a retried job never sends twice.
3. **Occurrence keys:**

   | Trigger                         | Occurrence key              |
   | ------------------------------- | --------------------------- |
   | `booking.starts_in`             | start (ISO, UTC)            |
   | `booking.completed`             | `"completed"`               |
   | `booking.created` / `cancelled` | `"created"` / `"cancelled"` |
   | `booking.rescheduled`           | `rescheduled_at`            |
   | `contact.date_field`            | the field's date            |
   | `conversation.inactive`         | `last_inbound_at`           |
   | `schedule`                      | the tick                    |

4. **Sweeper** (maintenance job, every minute, 2-hour lookback):
   - SQL per trigger finds subjects whose fire time is in (now − 2 h, now]. Date fields
     use the business timezone, and wall-clock arithmetic in Postgres
     (`(date + time + offset) AT TIME ZONE tz`). Malformed dates are skipped
     (`pg_input_is_valid`).
   - It also re-enqueues scheduled runs already due, in case a job was lost.
   - Event triggers insert runs as soon as the booking tool emits the event. The sweeper
     finds the same occurrences from the booking's timestamps, so a failed event costs a
     minute, not the message.
   - `booking.starts_in` only selects active bookings, and never a fire time before the
     booking was created or moved (B29).
5. **At send time** (`executeRun`), in order:
   1. The run is still scheduled and due; the business is active; the rule still exists
      and is enabled.
   2. The occurrence is still current: same start, field value or last message (B29).
      Otherwise the run is skipped as `stale_occurrence`.
   3. Always applied: not opted out, consent given (A13).
   4. The rule's conditions. `run_sent` matches the same subject, and also the same
      occurrence when both rules are `starts_in` (B30).
   5. `quiet_hours` (20:00–08:00, business time) applies only to rules that list it. The
      run is postponed to 08:00 with a new job; everything is re-checked then.
   6. The action.
6. **Actions:**
   - `send_template` needs Meta status `APPROVED` and the marketing cap when Meta's category
     is MARKETING (B31). Every variable must resolve (A10); values are flattened to one line
     for Meta.
   - Quick-reply payloads are `<rule_key>:<run_id>:<payload>`. The message stores its
     category and buttons.
   - `send_text` only goes out inside the 24-hour window.
   - `update_booking` confirms only a pending booking. Cancelling emits `booking.cancelled`.
   - `update_contact` values are validated against `contact_fields`.
   - `notify_staff` creates a `staff_notifications` row (A15).
   - `start_agent` works from buttons only. As a scheduled action it is skipped, because
     the agent answers messages and can't open a conversation.
7. **Button replies** run inside the agent, after the emergency and opt-out checks:
   - A tap finds its run from the payload. It is honored only if the run belongs to the
     tapping contact and the rule has `on_button` for it.
   - Typing a button's text counts as a tap (A11), but only while a template from the past
     72 hours is the last message we sent. Otherwise "Confirmo", said to the agent's
     read-back of a new booking, would confirm the old reminder instead.
   - A tap on a message whose booking moved or ended does nothing. The agent explains
     instead.
   - During a handoff (A12), data actions run, nothing is said, and staff are notified.
   - `start_agent` passes the agent an English note with the booking and the intent.
8. **Meta templates.** `activateBusiness` records one row per `wa_templates` entry: name,
   language, the components we want at Meta, and the category requested. A `sync-wa-templates`
   job runs every 15 minutes:
   - When `META_TEMPLATE_SUBMISSION=on`, it creates missing templates and edits changed
     bodies (A16). If a name and language already exist at Meta, the template is adopted
     only when its body is ours.
   - It then reads Meta's list and syncs status, category and id, to catch missed
     webhooks. The list's string ids are authoritative.
   - Webhooks update rows by name and language for every business on that WABA. The
     template id arrives as a JSON number, rounded past 2^53, so a webhook only fills in
     an id that is exact. A REINSTATED event counts as APPROVED. Rejections, pauses and
     disables raise an alert.
9. **Usage warnings (C3).** At 90% of a monthly cap, and at the cap itself, staff get one
   notification per month (dedupe key `usage:<cap>:<percent>:<yyyy-MM>`). This covers AI
   spend and marketing messages.
   - The marketing cap is `limits.marketing_msgs_month`, else `MARKETING_MSGS_MONTH` (500).
   - It counts this month's template messages whose recorded category is MARKETING.
10. **Staff texts** (notifications) are written in Spanish in code, like the admin's UI
    labels. Customer-facing text still comes only from templates.

## Consequences

- Reminders, review requests and recalls need Meta-approved templates. Until submission is
  turned on, those runs end as `template_not_approved`.
- Concurrent marketing sends can overshoot the cap by at most the worker's concurrency
  (5).
- `staff_notifications.text` can name patients. The retention purge (M7) must clear it
  along with message text.
- The admin (M5) shows blocked automations (template not approved), notifications, rule
  toggles and overrides (`updateAutomationSettings`).

## Open

- WhatsApp cost in `usage_events` (`wa_*`, spec review B23) moves to M5. `/usage` needs it
  there, and Colombia's rates must be checked against Meta's current rate card. Nothing is
  lost meanwhile: every outbound message already stores Meta's `pricing` block.
- Template upgrades (re-seeding rules, re-syncing templates on a new pinned version) come
  with M5's upgrade flow. `activateBusiness` already does both and is safe to call again.
- `notify_staff` over WhatsApp to a staff number (A15) is not built; v1 uses the inbox.
