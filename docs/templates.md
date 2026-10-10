# Writing vertical templates

A vertical template is one YAML file (`templates/<slug>/template.yaml`) that turns the
generic platform into an agent for one kind of business. Templates are data. They pick and
configure capabilities the code provides, and can never run code (principle 2).

```sh
pnpm template validate templates/odontologia                          # every rule below
pnpm template validate templates/odontologia --previous path/to/1.0.0 # plus upgrade rules
```

Errors name the exact path and YAML line, for example
`automations[3].action.template "resena" is not declared in wa_templates`.

## Top-level keys

| Key              | Required                | Purpose                                                                                                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `manifest`       | yes                     | slug, name, semver `version`, `locale` (es-CO), `min_platform_version`, description, declared `capabilities` |
| `config_schema`  | yes                     | JSON Schema (2020-12) for what each business fills in                                                        |
| `contact_fields` | no                      | Extra per-contact fields (JSON Schema per field)                                                             |
| `consent`        | yes                     | Consent message, accept patterns, FAQ-before-consent switch                                                  |
| `booking`        | if a booking tool is on | Booking rules                                                                                                |
| `agent`          | yes                     | Model, limits, tools, prompts, fixed replies                                                                 |
| `guardrails`     | yes                     | Price guard, emergency patterns and reply, opt-out keywords and reply                                        |
| `wa_templates`   | no                      | WhatsApp (Meta) message templates for automations                                                            |
| `automations`    | no                      | Rules: trigger, conditions, action, button handlers                                                          |
| `evals`          | yes                     | Test scenarios (at least one)                                                                                |
| `sample_config`  | yes                     | A full fictional config; must validate against `config_schema`                                               |
| `eval_fixtures`  | no                      | Resources and other eval-only data                                                                           |

Unknown keys are errors at every level, so typos never pass silently.

## `config_schema`

Standard JSON Schema 2020-12 with an `object` root, compiled by Ajv in strict mode: unknown
keywords are errors. Defaults are applied (`useDefaults`), and the defaulted config is what
gets stored and rendered.

**Platform types.** Reference these with `$ref: "platform:<name>"`. Next to the ref, only
annotations are allowed (`title`, `description`, `default`, `examples`, `x-ui`…), never
validation keywords.

| Type           | Meaning                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weekly_hours` | `{ mon … sun: [{ open: "HH:mm", close: "HH:mm" }] }`. Missing days default to `[]` (closed). `close` may be `24:00`. Ranges must be ordered and non-overlapping. |
| `money_cop`    | integer ≥ 0                                                                                                                                                      |
| `duration_min` | integer, multiple of 5, ≥ 5                                                                                                                                      |
| `phone_co`     | optional `+57`, then 10 digits starting with `3` (mobile) or `60` (landline); spaces or dashes allowed                                                           |
| `url`          | `http(s)://` URI                                                                                                                                                 |

**UI hints.** `x-ui: { section, order, help, widget, labels }`, where `widget` is one of
`textarea`, `weekly-hours` or `table`.

`labels` names the choices of a field with `enum`. The form shows the name and stores the
value, so prompts and rules keep using the values. A value without a name shows as written.
Every key must be one of the field's values.

```yaml
price_type:
  type: string
  enum: [fixed, from, after_evaluation]
  x-ui: { labels: { fixed: Precio fijo, from: Desde (precio mínimo) } }
```

**Catalogs.** A catalog is a config array of objects with at least `key` and `name`.
Booking uses `booking.catalog_path` (default `services`) and needs `duration_min` on items
when `duration_from: service`. The price guard needs an integer price field and, if
`price_type_field` is set, an enum whose values are among `fixed`, `from` and
`after_evaluation`.

**Reserved names.** `timezone`, plus `<field>_list` for every `weekly_hours` field. The
platform computes those.

## `contact_fields`

Field name → JSON Schema. Names are lowercase with underscores. These names are reserved:
`name`, `upcoming_bookings`, `id`, `wa_number`, `wa_profile_name`, `fields`, `consent_at`,
`opted_out_at`, `created_at`. A field used by a `contact.date_field` trigger needs
`format: date`.

## `booking`

| Rule                                                                 | Value                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `resource_kind`                                                      | kind of resource to book (`chair`, `table`…)                        |
| `resource_label`                                                     | human label                                                         |
| `duration_from`                                                      | `service` (item's `duration_min`) or `fixed` (`fixed_duration_min`) |
| `buffer_min`, `max_days_ahead`, `min_notice_hours`, `slots_to_offer` | integers                                                            |
| `require_explicit_confirmation`                                      | boolean                                                             |
| `collect`                                                            | subset of `subject_name`, `party_size`, `notes`                     |
| `catalog_path`                                                       | optional, default `services`                                        |

**Config references.** `fixed_duration_min`, `buffer_min`, `max_days_ahead`,
`min_notice_hours`, `slots_to_offer` and `require_explicit_confirmation` can come from the
business config instead: `min_notice_hours_config: booking_notice_hours`. The referenced
field must exist, have a compatible type, and be required or have a default.

## `agent.tools`

Tools come from the code registry. The template enables a tool and binds its server-side
params; the model never sees those params.

| Tool                 | Template params                                                                                       | Before consent |
| -------------------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| `lookup_catalog`     | `catalog_path`                                                                                        | yes            |
| `check_availability` | optional overrides of booking rules                                                                   | yes            |
| `book`, `reschedule` | optional `require_explicit_confirmation`, `collect`                                                   | **disabled**   |
| `find_bookings`      | —                                                                                                     | yes            |
| `cancel`             | `require_confirmation`                                                                                | **disabled**   |
| `handoff`            | `reasons` (must include `error`, `price_guard`, `budget` and the emergency reason); optional `labels` | yes            |
| `update_contact`     | `writable_fields` (from `contact_fields`)                                                             | **disabled**   |

`handoff.labels` maps reasons to what staff read in the inbox and reports, for example
`pide_humano: Pide hablar con una persona`. The model never sees them. Reasons without a
label show humanized (`pide_humano` → "Pide humano"). The admin already names the
platform's own reasons (`error`, `price_guard`, `budget`).

`handoff` is mandatory (principle 7). Every enabled tool must also be listed in
`manifest.capabilities.tools`. The model gets the tools in that list's order. Keep the
order stable: it is part of the cached prompt prefix.

What the model passes in (prompts can refer to these names):

- `check_availability`:
  - required: `service_key`, `date_from`, `date_to` (local `YYYY-MM-DD`);
  - optional: `time_of_day` (`morning` < 12:00 ≤ `afternoon` < 18:00 ≤ `evening`),
    `party_size`, and `around_time` (`"HH:mm"`, for "¿puede ser a las 3?"). The result
    then says whether that exact time is free, plus the nearest alternatives.
  - Public holidays the business doesn't open on never have slots. The result lists them
    under `closed_holidays`.
- `book`: `service_key`, `starts_at` (as returned by `check_availability`), `subject_name`,
  `for_self`, optional `party_size` and `notes`, `confirmed_by_customer`, `proposal_id`.
  - `for_self` is true when the person writing will attend. Only then does
    `subject_name` become `contact.name`.
- `reschedule`: `booking_id`, `new_starts_at`, `confirmed_by_customer`, `proposal_id`.
- `cancel`: `booking_id`, `confirmed_by_customer`, `proposal_id`.

Confirmation is two-step and enforced by the server (ADR 0008):

1. The first call returns `needs_confirmation` with a summary to read back: service, date
   label and catalog price.
2. A confirmed call only acts if the customer replied in a later message and the details
   are the same as the proposal's.

Prompts should ask for an explicit "sí" after reading the summary back.

## Liquid

The engine is liquidjs with strict variables and filters and `lenientIf`. It has no file
system and limits parse size, render time and memory.

- **Tags:** `if`, `unless`, `case`, `for`, `break`, `continue`, `assign`, `capture`,
  `comment`, `raw`, `echo`, `liquid`, `#`. `include`, `render` and `layout` don't exist.
- **Filters:**
  - `cop`: `120000` → `120.000`.
  - `join`, `default`, `upcase`, `downcase`.
  - `date`: a Luxon format, applied in the business timezone.
- **Unknown variables are errors.** For optional data, wrap the use in `{% if x %}` or use
  `| default: "…"`.
- **Optional config values are always declared.** A blank optional field is `null` (or `[]`
  for arrays), so a real business with a blank field can't crash a render that validated
  against `sample_config`.
- **Output is tidied:** trailing spaces are removed and runs of blank lines collapse into
  one.

### What each string can use

| Where                                                                                                                                            | Variables                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `agent.system_prompt`, `agent.facts_template` (cached block)                                                                                     | `business`, `agent`, `booking` (rules)                                                     |
| `agent.dynamic_context`, `agent.*_reply`, `agent.unsupported_media`, `consent.message`, `guardrails.emergency.reply`, `guardrails.opt_out_reply` | the above + `now`, `contact`                                                               |
| Automation texts (`send_text`, `notify_staff`, `update_contact` values) and `wa_templates` variables                                             | `business`, `contact`, `now`, and `booking` (**the booking subject**) for booking triggers |

`booking` means different things in different places. In prompts it holds the template's
booking rules. In automations it is the booking that fired the rule.

### Variables

- **`business.*`**: every `config_schema` field, plus:
  - `timezone`;
  - `<field>_list` for weekly hours: a list of `{ key, label: "Lunes", ranges: "8:00 a. m. a
12:00 m. y 1:00 p. m. a 6:00 p. m." | "cerrado", closed }`.
- **`agent.*`**: `model`, `max_reply_words`, `max_tool_calls_per_turn`, `history_messages`.
- **`booking.*` in prompts**: the resolved booking rules (`_config` already applied) and
  `catalog_path`.
- **`now.*`**: `iso`, `date` (ISO), `time` ("9:00 a. m."), `long` ("lunes 5 de octubre de
  2026, 9:00 a. m."), and `calendar`, the next 14 days as
  `{ date: "2026-10-08", label: "jueves 8 de octubre", relative: "hoy" | "mañana" | "pasado
mañana" | null, holiday }`. `holiday` is null on normal days. On a Colombian public
  holiday it is `{ name: "Día de la Diversidad Étnica y Cultural", open }`; `open` is true
  only when the business switched that holiday on (ADR 0009). Render it so the agent knows
  the day is closed.
- **`contact.*`**:
  - `name`: null until the person gives a name;
  - every `contact_fields` key (null when unset);
  - `upcoming_bookings`, a list of
    `{ id, service_key, service_name, subject_name, status, starts_at, label }`.
- **`booking.*` in automations**: `id`, `service_key`, `service_name`, `subject_name`,
  `party_size`, `status`, `source`, `starts_at`, `ends_at`, `label` ("jueves 8 de octubre,
  3:00 p. m."), `date_long`, `time`, `local_date`, `resource_name`, `notes`.

Dates and money use Colombian Spanish from fixed tables, not `Intl`: "3:00 p. m.",
"12:00 m." for noon, "120.000".

## Regexes

`consent.accept_patterns`, `guardrails.emergency.patterns` and eval `reply_not_matches` are
compiled with the `iu` flags. In JavaScript `\b` only understands ASCII, so `s[ií]\b` never
matches "sí". The validator rejects `\b` next to a non-ASCII letter on either side. Use a
lookahead instead: `s[ií](?![a-zñáéíóú])`.

## `guardrails`

- **Price guard:** every money amount in a reply must equal the price of a `fixed` or `from`
  catalog item. `after_evaluation` services never have an amount quoted. Recognized formats:
  `$120.000`, `120.000`, "120 mil", "1,2 millones" and "120k". A failing reply is rewritten
  once; if it still fails, the customer gets `agent.fallback_reply` and staff get a handoff.
- **Emergency:** patterns are checked before anything else, including consent. A match
  sends `reply` and opens a handoff with `handoff_reason`.
- **Opt-out:** a single-word keyword (`PARA`, `STOP`) counts only when it is the whole
  message burst. A phrase ("no me escriban") counts anywhere as a whole phrase. Matching
  ignores case and accents.

## `wa_templates`

Meta's rules are checked at upload: the body has at most 1024 characters, and
placeholders:

- look like `{{1}}`;
- are numbered 1, 2, 3… in order of appearance and appear once each;
- never start or end the body;
- are never adjacent with nothing between them.

The number of `variables` and `examples` must match the number of placeholders, and
examples can't contain newlines, tabs or 5+ spaces. Quick-reply buttons have text of at
most 25 characters, at most 10 per template, and unique payloads. Too many placeholders for
the amount of fixed text gives a warning, because Meta publishes no exact ratio.

A variable is a context path (`booking.service_name`) or
`{ paths: [contact.name, booking.subject_name], fallback: "…" }`, meaning the first
non-empty value wins. If no fallback is given and everything is empty, the message is
skipped, because Meta rejects empty parameters. Every path must exist in the context of
each automation that sends the template.

Templates are submitted to Meta as `<key>_v<major>`.

## `automations`

| Trigger                                                         | Subject      | Params                                                     |
| --------------------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| `booking.created` / `booking.rescheduled` / `booking.cancelled` | booking      | —                                                          |
| `booking.starts_in`                                             | booking      | `offset` (negative, e.g. `-24h`)                           |
| `booking.completed`                                             | booking      | `offset` (≥ 0)                                             |
| `contact.date_field`                                            | contact      | `field`, `offset` (e.g. `180d`), `at_local_time` (`HH:mm`) |
| `conversation.inactive`                                         | conversation | `duration`                                                 |
| `schedule`                                                      | business     | `cron` (5 fields)                                          |

- **Conditions:**
  - `{ field: booking.status | contact.<f> | business.<path>, eq | in | exists |
not_exists }`.
  - `{ builtin: not_opted_out | has_consent | quiet_hours | no_future_booking }`.
  - `{ builtin: run_sent, rule: <other rule key> }`.
  - `booking.*` fields only work with booking triggers.
- **Actions:**
  - `send_template` (`template`);
  - `send_text` (`text`, Liquid);
  - `update_booking` (`set.status`: `confirmed` | `cancelled`; booking triggers only);
  - `update_contact` (`set: { <contact field>: <value or Liquid> }`);
  - `notify_staff` (`text`);
  - `start_agent` (`intent`: `book` | `reschedule` | `cancel` | `general`).
- **`on_button.<payload>`:** actions for each quick-reply payload of the template the rule
  sends.
- **`overridable`:** trigger params a business may change, e.g. `trigger.offset`.

How rules run (ADR 0010):

- **When:** the sweeper checks every minute, looking back 2 hours. `booking.created`,
  `rescheduled` and `cancelled` fire as soon as the booking changes. A rule fires at most
  once per subject and occurrence. For example, a reschedule makes a new reminder
  occurrence, and the old one never fires.
- **Never before the booking existed:** a `booking.starts_in` time that falls before the
  booking was made (or moved) is skipped. A booking made 10 hours ahead gets no 24-hour
  reminder.
- **Always applied:** a contact who opted out, or never gave consent, gets nothing, and
  their data rules don't run either. No condition is needed for this.
- **Everything is checked at send time.** The booking must still start when the run
  expected, and the conditions must hold. `quiet_hours` only applies to rules that list it:
  between 20:00 and 08:00 (business time), the run waits until 08:00.
- **`send_template`:**
  - only goes out once Meta has approved the template;
  - the template's MARKETING messages count against the business's monthly cap;
  - a variable that stays empty skips the run.
- **`send_text`:** only inside the 24-hour window, else skipped.
- **`start_agent`:** only in `on_button`, where it hands the conversation to the agent with
  the intent. As a rule's own action it can't run (the validator warns).
- **Button replies:**
  - The handlers run even during a handoff, but then only `update_booking`,
    `update_contact` and `notify_staff` act; staff are told about the tap.
  - Typing a button's text ("Confirmo") counts as tapping it, while that template is the
    last message the business sent (within 72 hours).
  - A tap on a message about a booking that moved or ended does nothing; the agent answers
    instead.
- **Outcomes:** every run ends as `sent` (the action was carried out), `skipped` with a
  reason, or `failed`.

## `evals`

A scenario has these fields:

- `id` and `critical`;
- optional `clock` (ISO with offset; the default is `2026-10-05T09:00:00-05:00`);
- optional `consent: pending`;
- optional `fixtures` (`bookings`, `contact`);
- `turns` (`user:` or `expect_tool:`);
- `assert`.

Assertions:

- `tool_called`, `no_tool`;
- `booking_created`, `bookings_count`;
- `handoff`, `no_handoff`;
- `reply_contains`, `reply_not_matches`, `reply_contains_price`;
- `judge`.

The validator checks that tools are enabled, that services exist (and are bookable for
fixtures), that handoff reasons are allowed, and that `eval_fixtures.resources` has the
booking resource kind.

## Versions

Versions are semver, and a published version is immutable. Each upload is compared with the
highest published version below it:

- The version must increase.
- Within the same major version:
  - the previous `sample_config` must still validate;
  - message templates may only change body text (Meta edits them in place);
  - changing variables, buttons, category or language, or removing a template, needs a new
    major version.
