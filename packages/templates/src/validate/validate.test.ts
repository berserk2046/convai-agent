import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, type Document } from "yaml";
import { validateTemplateSource, type ValidateOptions } from "./index.ts";

const ODONTOLOGIA = readFileSync(
  new URL("../../../../templates/odontologia/template.yaml", import.meta.url),
  "utf8",
);

/** Appendix A with one change applied through the YAML document API. */
function mutate(change: (doc: Document) => void): string {
  const doc = parseDocument(ODONTOLOGIA);
  change(doc);
  return doc.toString();
}

function errorsOf(source: string, options?: ValidateOptions) {
  return validateTemplateSource(source, options).issues.filter((i) => i.severity === "error");
}

describe("templates/odontologia (Appendix A)", () => {
  const report = validateTemplateSource(ODONTOLOGIA);

  it("validates with no errors or warnings", () => {
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("parses into the typed template", () => {
    expect(report.template?.manifest).toMatchObject({ slug: "odontologia", version: "1.0.0" });
    expect(report.template?.guardrails.opt_out_keywords).toContain("PARA");
  });
});

interface BrokenCase {
  name: string;
  source: () => string;
  path: string;
  message: RegExp;
  options?: ValidateOptions;
}

const set = (path: (string | number)[], value: unknown) => () =>
  mutate((d) => d.setIn(path, value));
const del = (path: (string | number)[]) => () => mutate((d) => d.deleteIn(path));
const edit = (path: (string | number)[], change: (value: string) => string) => () =>
  mutate((d) => d.setIn(path, change(String(d.getIn(path)))));

const BROKEN: BrokenCase[] = [
  // Rule 1: YAML and meta-schema
  {
    name: "YAML syntax error",
    source: () => `${ODONTOLOGIA}\nbroken: [unclosed`,
    path: "",
    message: /^YAML: /,
  },
  {
    name: "duplicate key",
    source: () =>
      ODONTOLOGIA.replace(
        "  name: Consultorio odontológico\n",
        "  name: Consultorio odontológico\n  name: Otro\n",
      ),
    path: "",
    message: /YAML: Map keys must be unique/,
  },
  {
    name: "missing consent section",
    source: del(["consent"]),
    path: "consent",
    message: /is required/,
  },
  {
    name: "misspelled top-level key",
    source: set(["automation"], []),
    path: "automation",
    message: /not a known field/,
  },
  {
    name: "unknown field in a section",
    source: set(["agent", "max_reply_word"], 50),
    path: "agent.max_reply_word",
    message: /not a known field/,
  },
  {
    name: "non-boolean flag",
    source: set(["consent", "allow_faq_before_consent"], "yes"),
    path: "consent.allow_faq_before_consent",
    message: /expected boolean/,
  },
  // Rule 2: versions
  {
    name: "version not semver",
    source: set(["manifest", "version"], "1.0"),
    path: "manifest.version",
    message: /semantic version/,
  },
  {
    name: "needs a newer platform",
    source: set(["manifest", "min_platform_version"], "9.0.0"),
    path: "manifest.min_platform_version",
    message: /needs platform 9\.0\.0/,
  },
  {
    name: "version already published",
    source: () => ODONTOLOGIA,
    options: { publishedVersions: ["1.0.0"] },
    path: "manifest.version",
    message: /already published/,
  },
  // Rule 3: config_schema
  {
    name: "invalid JSON Schema type",
    source: set(["config_schema", "properties", "city", "type"], "strin"),
    path: "config_schema.properties.city.type",
    message: /must be/,
  },
  {
    name: "misspelled schema keyword (strict mode)",
    source: set(["config_schema", "properties", "city", "maxLenght"], 5),
    path: "config_schema.properties.city.maxLenght",
    message: /unknown keyword/,
  },
  {
    name: "unknown platform type",
    source: set(["config_schema", "properties", "maps_url", "$ref"], "platform:link"),
    path: "config_schema.properties.maps_url.$ref",
    message: /unknown platform type "link"/,
  },
  {
    name: "validation keyword next to a platform ref",
    source: set(["config_schema", "properties", "phone_urgencias", "minLength"], 7),
    path: "config_schema.properties.phone_urgencias.minLength",
    message: /can't be combined/,
  },
  {
    name: "unknown x-ui widget",
    source: set(["config_schema", "properties", "address", "x-ui", "widget"], "map"),
    path: "config_schema.properties.address.x-ui.widget",
    message: /allowed values/,
  },
  {
    name: "config field shadows a computed one",
    source: set(["config_schema", "properties", "hours_list"], { type: "string" }),
    path: "config_schema.properties.hours_list",
    message: /reserved/,
  },
  // Rule 4: sample_config
  {
    name: "fixed price without amount",
    source: del(["sample_config", "services", 0, "price_cop"]),
    path: "sample_config.services[0].price_cop",
    message: /is required/,
  },
  {
    name: "bad phone number",
    source: set(["sample_config", "phone_urgencias"], "12345"),
    path: "sample_config.phone_urgencias",
    message: /must match pattern/,
  },
  {
    name: "hours that close before they open",
    source: set(["sample_config", "hours", "sat"], [{ open: "13:00", close: "08:00" }]),
    path: "sample_config.hours.sat[0]",
    message: /opens at 13:00 but closes at 08:00/,
  },
  // Rule 5: Liquid
  {
    name: "unknown variable in the system prompt",
    source: edit(["agent", "system_prompt"], (s) => `${s}\n{{ business.nombre }}`),
    path: "agent.system_prompt",
    message: /undefined variable: business\.nombre/,
  },
  {
    name: "unknown filter",
    source: edit(["agent", "facts_template"], (s) => `${s}\n{{ business.city | money }}`),
    path: "agent.facts_template",
    message: /undefined filter: money/,
  },
  {
    name: "include tag",
    source: edit(["agent", "dynamic_context"], (s) => `${s}\n{% include 'otro' %}`),
    path: "agent.dynamic_context",
    message: /Liquid syntax error: tag "include" not found/,
  },
  {
    name: "unclosed if",
    source: set(["agent", "handoff_reply"], "{% if contact.name %}Hola"),
    path: "agent.handoff_reply",
    message: /Liquid syntax error/,
  },
  {
    name: "booking subject variable in a reply",
    source: set(["guardrails", "opt_out_reply"], "Listo {{ booking.label }}"),
    path: "guardrails.opt_out_reply",
    message: /undefined variable: booking\.label/,
  },
  {
    // The sample clock's calendar includes a public holiday, so holiday fields are checked.
    name: "unknown holiday field in the calendar",
    source: edit(["agent", "dynamic_context"], (s) =>
      s.replace("d.holiday.name", "d.holiday.nombre"),
    ),
    path: "agent.dynamic_context",
    message: /undefined variable: d\.holiday\.nombre/,
  },
  {
    name: "now in the cached system prompt",
    source: edit(["agent", "system_prompt"], (s) => `${s}\nHoy es {{ now.long }}`),
    path: "agent.system_prompt",
    message: /undefined variable: now/,
  },
  // Rule 6: tools
  {
    name: "unknown tool",
    source: set(["agent", "tools", "teleport"], {}),
    path: "agent.tools.teleport",
    message: /unknown tool "teleport"/,
  },
  {
    name: "tool param out of range",
    source: set(["agent", "tools", "check_availability", "slots_to_offer"], 0),
    path: "agent.tools.check_availability.slots_to_offer",
    message: />=1/,
  },
  {
    name: "unknown tool param",
    source: set(["agent", "tools", "cancel", "require_confirmations"], true),
    path: "agent.tools.cancel.require_confirmations",
    message: /not a known field/,
  },
  {
    name: "handoff without a platform reason",
    source: set(["agent", "tools", "handoff", "reasons"], ["urgencia", "error", "budget"]),
    path: "agent.tools.handoff.reasons",
    message: /must include "price_guard"/,
  },
  {
    name: "no handoff tool",
    source: del(["agent", "tools", "handoff"]),
    path: "agent.tools",
    message: /must enable handoff/,
  },
  {
    name: "tool enabled but not declared",
    source: set(["agent", "tools", "update_contact"], { writable_fields: ["is_minor"] }),
    path: "manifest.capabilities.tools",
    message: /must declare "update_contact"/,
  },
  {
    name: "writable field that doesn't exist",
    source: () =>
      mutate((d) => {
        d.setIn(["agent", "tools", "update_contact"], { writable_fields: ["mascota"] });
        d.addIn(["manifest", "capabilities", "tools"], "update_contact");
      }),
    path: "agent.tools.update_contact.writable_fields[0]",
    message: /"mascota" is not in contact_fields/,
  },
  {
    name: "_config pointing nowhere",
    source: set(["booking", "min_notice_hours_config"], "anticipacion"),
    path: "booking.min_notice_hours_config",
    message: /"anticipacion" does not exist/,
  },
  {
    name: "_config with the wrong type",
    source: set(["booking", "min_notice_hours_config"], "city"),
    path: "booking.min_notice_hours_config",
    message: /is a string, but min_notice_hours needs integer/,
  },
  {
    name: "missing booking rule",
    source: del(["booking", "buffer_min"]),
    path: "booking.buffer_min",
    message: /is required/,
  },
  {
    name: "price guard on a missing catalog",
    source: set(["guardrails", "price_guard", "catalog_path"], "servicios"),
    path: "guardrails.price_guard.catalog_path",
    message: /catalog "servicios"/,
  },
  // Rule 7: automations
  {
    name: "unknown trigger",
    source: set(["automations", 0, "trigger", "type"], "booking.starts_soon"),
    path: "automations[0].trigger.type",
    message: /unknown trigger/,
  },
  {
    name: "positive offset before a booking",
    source: set(["automations", 0, "trigger", "offset"], "24h"),
    path: "automations[0].trigger.offset",
    message: /must be negative/,
  },
  {
    name: "date trigger on a non-date field",
    source: set(["automations", 4, "trigger", "field"], "guardian_name"),
    path: "automations[4].trigger.field",
    message: /must have format: date/,
  },
  {
    name: "template that doesn't exist",
    source: set(["automations", 3, "action", "template"], "resena"),
    path: "automations[3].action.template",
    message: /"resena" is not declared/,
  },
  {
    name: "unknown action",
    source: set(["automations", 3, "action", "type"], "send_email"),
    path: "automations[3].action.type",
    message: /unknown action/,
  },
  {
    name: "button handler without a button",
    source: () =>
      mutate((d) => {
        d.setIn(
          ["automations", 0, "on_button", "confirmar"],
          d.getIn(["automations", 0, "on_button", "confirm"]),
        );
        d.deleteIn(["automations", 0, "on_button", "confirm"]);
      }),
    path: "automations[0].on_button.confirmar",
    message: /not a button payload/,
  },
  {
    name: "condition on a missing config field",
    source: set(["automations", 3, "conditions", 0, "field"], "business.reviews_url"),
    path: "automations[3].conditions[0].field",
    message: /"reviews_url" is not in config_schema/,
  },
  {
    name: "booking condition on a contact trigger",
    source: () =>
      mutate((d) =>
        d.addIn(["automations", 4, "conditions"], { field: "booking.status", eq: "pending" }),
      ),
    path: "automations[4].conditions[1].field",
    message: /only available when the trigger's subject is a booking/,
  },
  {
    name: "invalid booking status",
    source: set(["automations", 1, "conditions", 0, "eq"], "pendiente"),
    path: "automations[1].conditions[0].eq",
    message: /not a booking status/,
  },
  {
    name: "run_sent on a missing rule",
    source: set(["automations", 1, "conditions", 1, "rule"], "recordatorio"),
    path: "automations[1].conditions[1].rule",
    message: /not another automation/,
  },
  {
    name: "update of an unknown contact field",
    source: set(["automations", 2, "action", "set"], {
      ultima_limpieza: "{{ booking.local_date }}",
    }),
    path: "automations[2].action.set.ultima_limpieza",
    message: /not in contact_fields/,
  },
  {
    name: "update value that breaks the field type",
    source: set(["automations", 2, "action", "set", "last_cleaning_date"], "{{ booking.label }}"),
    path: "automations[2].action.set.last_cleaning_date",
    message: /must match format "date"/,
  },
  {
    name: "override of a non-timing field",
    source: set(["automations", 0, "overridable"], ["action.template"]),
    path: "automations[0].overridable[0]",
    message: /can't be overridden/,
  },
  // Rule 8: Meta message templates
  {
    name: "body starting with a placeholder",
    source: set(
      ["wa_templates", 2, "body"],
      "{{1}}, ya pasaron 6 meses desde su última limpieza en {{2}}. ¿Le agendamos su control?",
    ),
    path: "wa_templates[2].body",
    message: /must not start with a placeholder/,
  },
  {
    name: "adjacent placeholders",
    source: edit(["wa_templates", 0, "body"], (b) => b.replace("{{4}} a las {{5}}", "{{4}} {{5}}")),
    path: "wa_templates[0].body",
    message: /nothing between them/,
  },
  {
    name: "fewer samples than placeholders",
    source: () => mutate((d) => d.deleteIn(["wa_templates", 1, "examples", 2])),
    path: "wa_templates[1].examples",
    message: /has 2 entries but the body has 3 placeholders/,
  },
  {
    name: "variable unavailable for the trigger",
    source: set(["wa_templates", 2, "variables", 1], "booking.service_name"),
    path: "wa_templates[2].variables[1]",
    message: /not available when sent from a contact trigger/,
  },
  {
    name: "button text over Meta's limit",
    source: set(["wa_templates", 0, "buttons", 1, "text"], "Necesito cambiar la fecha de la cita"),
    path: "wa_templates[0].buttons[1].text",
    message: /at most 25 characters/,
  },
  {
    name: "unsupported language code",
    source: set(["wa_templates", 0, "language"], "es_419"),
    path: "wa_templates[0].language",
    message: /not a language code Meta supports/,
  },
  // Rule 9: evals
  {
    name: "eval on an unknown service",
    source: set(["evals", 0, "assert", "reply_contains_price", "service_key"], "implante"),
    path: "evals[0].assert.reply_contains_price.service_key",
    message: /"implante" is not a service/,
  },
  {
    name: "eval expecting a disabled tool",
    source: set(["evals", 2, "assert", "tool_called"], "update_contact"),
    path: "evals[2].assert.tool_called",
    message: /not enabled/,
  },
  {
    name: "eval with an unknown handoff reason",
    source: set(["evals", 6, "assert", "handoff", "reason"], "emergencia"),
    path: "evals[6].assert.handoff.reason",
    message: /not one of agent\.tools\.handoff\.reasons/,
  },
  {
    name: "eval booking a non-bookable service",
    source: set(["evals", 4, "fixtures", "bookings", 0, "service_key"], "endodoncia"),
    path: "evals[4].fixtures.bookings[0].service_key",
    message: /not bookable/,
  },
  {
    name: "no resources of the booking kind",
    source: set(["eval_fixtures", "resources"], [{ kind: "table", name: "Mesa 1" }]),
    path: "eval_fixtures.resources",
    message: /resource of kind "chair"/,
  },
  {
    name: "eval clock without offset",
    source: set(["evals", 2, "clock"], "2026-10-05T09:00:00"),
    path: "evals[2].clock",
    message: /with offset/,
  },
  // Rule 10: regexes
  {
    name: "\\b after an accented letter",
    source: set(["consent", "accept_patterns", 0], "^\\s*s[ií]\\b"),
    path: "consent.accept_patterns[0]",
    message: /ASCII-only/,
  },
  {
    name: "regex that doesn't compile with u",
    source: set(["guardrails", "emergency", "patterns", 0], "cara\\-hinchada"),
    path: "guardrails.emergency.patterns[0]",
    message: /does not compile/,
  },
  {
    name: "bad regex in an eval",
    source: set(["evals", 1, "assert", "reply_not_matches", 0], "(\\$"),
    path: "evals[1].assert.reply_not_matches[0]",
    message: /does not compile/,
  },
  // Contact fields
  {
    name: "contact field named like a platform field",
    source: set(["contact_fields", "name"], { type: "string" }),
    path: "contact_fields.name",
    message: /reserved/,
  },
];

describe("warnings", () => {
  it("start_agent as a rule's own action can never run", () => {
    const report = validateTemplateSource(
      mutate((d) => d.setIn(["automations", 0, "action"], { type: "start_agent", intent: "book" })),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        path: "automations[0].action.type",
        message: expect.stringContaining("only works in on_button"),
      }),
    );
  });
});

describe("broken templates fail with precise paths", () => {
  it.each(BROKEN)("$name → $path", ({ source, path, message, options }) => {
    const errors = errorsOf(source(), options);
    expect(errors).toContainEqual(
      expect.objectContaining({ path, message: expect.stringMatching(message) }),
    );
  });

  it("reports the YAML line of each error", () => {
    const errors = errorsOf(set(["automations", 3, "action", "template"], "resena")());
    expect(errors[0]?.line).toBeGreaterThan(280);
  });
});

describe("upgrades (spec §10 lifecycle, decision A16)", () => {
  const previous = validateTemplateSource(ODONTOLOGIA).template ?? undefined;
  const bump = (version: string, change: (doc: Document) => void = () => undefined) =>
    mutate((d) => {
      d.setIn(["manifest", "version"], version);
      change(d);
    });

  it("accepts a minor version with text-only changes", () => {
    const source = bump("1.1.0", (d) =>
      d.setIn(
        ["wa_templates", 1, "body"],
        "Hola {{1}}, gracias por visitarnos en {{2}}. Su reseña nos ayuda mucho: {{3}} ¡Gracias!",
      ),
    );
    const report = validateTemplateSource(source, { previous });
    expect(report.ok).toBe(true);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        path: "wa_templates[1].body",
        message: expect.stringMatching(/solicitud_resena_v1 will be edited/),
      }),
    );
  });

  it.each<[string, () => string, string, RegExp]>([
    ["same version", () => ODONTOLOGIA, "manifest.version", /greater than the previous version/],
    [
      "category change in a minor",
      () => bump("1.1.0", (d) => d.setIn(["wa_templates", 0, "category"], "MARKETING")),
      "wa_templates[0].category",
      /bump the major version/,
    ],
    [
      "button change in a minor",
      () =>
        bump("1.0.1", (d) => d.setIn(["wa_templates", 0, "buttons", 0, "text"], "Sí, confirmo")),
      "wa_templates[0].buttons",
      /bump the major version/,
    ],
    [
      "removed template in a minor",
      () =>
        bump("1.1.0", (d) => {
          d.deleteIn(["wa_templates", 2]);
          d.deleteIn(["automations", 4]);
          d.setIn(
            ["manifest", "capabilities", "triggers"],
            ["booking.starts_in", "booking.completed"],
          );
        }),
      "wa_templates",
      /removes "control_6_meses"/,
    ],
    [
      "new required config field in a minor",
      () =>
        bump("1.1.0", (d) => {
          d.setIn(["config_schema", "properties", "nit"], { type: "string" });
          d.addIn(["config_schema", "required"], "nit");
          d.setIn(["sample_config", "nit"], "900123456");
        }),
      "config_schema",
      /breaks configs that were valid in 1\.0\.0 \(sample_config\.nit is required\)/,
    ],
  ])("rejects %s", (_name, source, path, message) => {
    expect(errorsOf(source(), { previous })).toContainEqual(
      expect.objectContaining({ path, message: expect.stringMatching(message) }),
    );
  });

  it("allows breaking changes in a major version", () => {
    const source = bump("2.0.0", (d) => d.setIn(["wa_templates", 0, "category"], "MARKETING"));
    expect(validateTemplateSource(source, { previous }).ok).toBe(true);
  });
});
