# 0014 — Display names for template codes

Status: accepted (M5)

## Context

Templates use short codes that code and prompts depend on, and staff saw those codes as
written:

- **Choices in the setup form.** The dental template's price type is
  `enum: [fixed, from, after_evaluation]`. The agent's prompt compares against these
  values, and so does the price guard (through `price_type_field`).
- **Handoff reasons.** The model picks one of the template's reasons (`clinico`,
  `pide_humano`…). The inbox and the reports showed them humanized: "Clinico", without its
  accent, and "Desconocido", which doesn't say what was unknown.

The admin can't keep a translation table for these, because each vertical has its own
codes (principle 1).

## Decision

1. **`x-ui.labels`** names an `enum`'s values: `{ value: "Label" }`.
   - The setup form passes it to RJSF as `ui:enumNames`, which shows the name and stores the
     value.
   - The validator rejects labels on a field without `enum`, keys that aren't among the
     field's values, and empty names.
2. **`agent.tools.handoff.labels`** names the template's handoff reasons for staff.
   - The services return the label with each open handoff and in the report's handoffs by
     reason.
   - The admin shows, in order: the template's label, then its own Spanish name for the
     platform's reasons (`error`, `price_guard`, `budget`, `staff`), then the humanized slug.
   - The model's tool input lists only the reasons, never the labels.
   - The validator rejects labels for reasons the template doesn't declare.
3. **Both are additive and optional.** Templates without labels stay valid and show what
   they showed before. Labels are annotations, so they change no validation, and adding
   them is a minor version. The dental template is now `1.1.0`, which passes
   `--previous 1.0.0`.
4. **Rejected: JSON Schema's own `oneOf: [{ const, title }]`.** RJSF can label choices that
   way. But it would turn an `enum` into a different schema, and several things expect an
   `enum` here: the price guard's `price_type_field` check, the template's `if`/`then`, and
   the upgrade comparison. A display name shouldn't change what validates.

## Consequences

- Tests read the dental template's version from the file (`ODONTOLOGIA_VERSION`, with
  `laterVersion()` and `odontologiaAt()` in `@platform/db/testing`), so the next bump
  needs no test edits.
- Businesses pinned to `odontologia@1.0.0` keep showing codes until the owner upgrades them
  to 1.1.0 (the upgrade flow, decision A16). The change has no config impact. No business
  is live yet.
