# 0004 — Template validation design

Status: accepted (M1)

## Decision

- **Two schema languages, each where it fits.**
  - **Zod for the meta-schema** (the shape of a template file). It gives TypeScript types
    for the parsed template and precise error paths.
  - **Ajv (2020-12, strict) for `config_schema`**, because business configs are user-facing
    JSON Schema that the admin form generator (RJSF) also reads.
- **Structure first, then cross-references.** The meta-schema checks shape only. Fields
  that point into registries (tool names, trigger types, action params) are loose there and
  checked by dedicated passes. That way an error says "unknown tool "teleport" (known: …)"
  instead of "invalid input".
- **Capability declarations live in `@platform/templates`** (`capabilities.ts`). They hold
  names and param schemas only. Implementations (core, M3; automations, M4) register
  against them, which avoids a dependency cycle (core needs the renderer; the validator
  needs the registry).
- **Platform refs are inlined, not registered with Ajv.** Ajv, RJSF and field-type checks
  then all see one plain schema. Only annotations may sit next to a `platform:` ref, so
  inlining never changes meaning. An internal `x-platform-type` marker records where a type
  was inlined, so weekly-hours checks and `<field>_list` can find it.
- **Render contexts are built by the same functions at validation time and at runtime**
  (`context.ts`). Every declared config property is always present (null, `[]`, or an
  object of nulls). Strict variables therefore catch typos without making blank optional
  fields crash production renders.
- **Each Liquid string is rendered against a "rich" and a "sparse" sample.** The sparse one
  has no contact name, fields or bookings. Together they exercise both sides of
  conditionals.
- **Spanish formatting uses fixed tables** (`@platform/shared`), not `Intl`, so snapshots
  and prompts are byte-stable across Node/ICU versions.
- **Meta template rules** are encoded from Meta's components reference and template-review
  page (fetched 2026-10). The variable-to-length ratio has no published number, so it is a
  warning.

## Changes to Appendix A

The spec allows fixing genuine schema mismatches, and the owner approved the other changes.
There were **no schema mismatches**: Appendix A validated unchanged under strict Ajv. The
changes come from approved decisions:

| Change                                                                                                     | Reason                                  |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `opt_out_keywords`: `BAJA` → `PARA`; eval `opt_out` sends `PARA`                                           | A2, Colombian usage                     |
| `dynamic_context`: 14-day calendar (`now.calendar`)                                                        | A6                                      |
| `recordatorio_cita` / `solicitud_resena` first variable: `{ paths: [contact.name, booking.subject_name] }` | A10, never send an empty or junk name   |
| `on_button.confirm` text: name only when known                                                             | A10, avoids "¡Gracias por confirmar, !" |
| `sin_confirmar` staff alert uses `booking.subject_name`                                                    | A10, staff-facing, always set           |
