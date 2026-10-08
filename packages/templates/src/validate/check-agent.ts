import {
  BOOKING_RULES,
  CONFIGURABLE_BOOKING_RULES,
  DEFAULT_CATALOG_PATH,
  PRICE_TYPES,
  SYSTEM_HANDOFF_REASONS,
  TOOLS,
  type JsonType,
  type ToolName,
} from "../capabilities.ts";
import { getPath } from "../context.ts";
import type { DocPath } from "../issues.ts";
import { isObject, type JsonSchema } from "../json-schema/platform-types.ts";
import { checkTemplateRegex } from "../regex.ts";
import {
  checkLiquid,
  configFieldAlwaysSet,
  configFieldSchema,
  contactFieldKeys,
  type CheckContext,
} from "./check-context.ts";
import { addZodIssues } from "./zod-issues.ts";

/** Rule 6: enabled tools exist, are declared, and their params validate. */
export function checkTools(ctx: CheckContext): void {
  const { agent, manifest, booking } = ctx.template;
  const known = Object.keys(TOOLS).join(", ");
  for (const [name, params] of Object.entries(agent.tools)) {
    const path: DocPath = ["agent", "tools", name];
    if (!(name in TOOLS)) {
      ctx.issues.error(path, `unknown tool "${name}" (known: ${known})`);
      continue;
    }
    const declaration = TOOLS[name as ToolName];
    const parsed = declaration.params.safeParse(params);
    if (!parsed.success) addZodIssues(ctx.issues, parsed.error, path);
    if (!manifest.capabilities.tools.includes(name)) {
      ctx.issues.error(
        ["manifest", "capabilities", "tools"],
        `must declare "${name}", which agent.tools enables`,
      );
    }
    if (declaration.usesBookingRules && !booking) {
      ctx.issues.error(["booking"], `is required because agent.tools enables ${name}`);
    }
  }

  // Principle 7: a human is always reachable.
  const handoff = agent.tools.handoff;
  if (!handoff) {
    ctx.issues.error(["agent", "tools"], "must enable handoff (a human is always reachable)");
  } else if (Array.isArray(handoff.reasons)) {
    const reasons = handoff.reasons as unknown[];
    const required = [...SYSTEM_HANDOFF_REASONS, ctx.template.guardrails.emergency.handoff_reason];
    for (const reason of required) {
      if (!reasons.includes(reason)) {
        ctx.issues.error(
          ["agent", "tools", "handoff", "reasons"],
          `must include "${reason}" (the platform uses it)`,
        );
      }
    }
  }

  const writable = agent.tools.update_contact?.writable_fields;
  if (Array.isArray(writable)) {
    const fields = contactFieldKeys(ctx);
    for (const [i, field] of (writable as unknown[]).entries()) {
      if (typeof field === "string" && !fields.includes(field)) {
        ctx.issues.error(
          ["agent", "tools", "update_contact", "writable_fields", i],
          `"${field}" is not in contact_fields`,
        );
      }
    }
  }

  const catalogPath = agent.tools.lookup_catalog?.catalog_path;
  if (typeof catalogPath === "string") {
    checkCatalog(ctx, ["agent", "tools", "lookup_catalog", "catalog_path"], catalogPath, []);
  }
}

/** Booking rules: `<rule>_config` references point at compatible config fields. */
export function checkBookingRules(ctx: CheckContext): void {
  const section = ctx.template.booking;
  if (!section || !ctx.config) return;
  for (const [rule, expected] of Object.entries(CONFIGURABLE_BOOKING_RULES)) {
    const field = section[`${rule}_config`];
    if (typeof field !== "string") continue;
    const path: DocPath = ["booking", `${rule}_config`];
    const schema = configFieldSchema(ctx, field);
    if (!schema) {
      ctx.issues.error(path, `config field "${field}" does not exist in config_schema`);
      continue;
    }
    if (!typeCompatible(schema, expected)) {
      ctx.issues.error(
        path,
        `config field "${field}" is ${describeType(schema)}, but ${rule} needs ${expected}`,
      );
      continue;
    }
    if (!configFieldAlwaysSet(ctx, field)) {
      ctx.issues.error(
        path,
        `config field "${field}" must be required or have a default, since ${rule} always needs a value`,
      );
    }
    const sample = ctx.sampleConfig ? getPath(ctx.sampleConfig, field) : undefined;
    const parsed = BOOKING_RULES[rule as keyof typeof BOOKING_RULES].safeParse(sample);
    if (ctx.sampleConfig && !parsed.success) {
      ctx.issues.error(
        path,
        `sample_config.${field} = ${JSON.stringify(sample)} is not a valid ${rule}: ${parsed.error.issues[0]?.message ?? ""}`,
      );
    }
  }

  const catalogPath =
    typeof section.catalog_path === "string" ? section.catalog_path : DEFAULT_CATALOG_PATH;
  const needs = section.duration_from === "service" ? ["duration_min"] : [];
  checkCatalog(
    ctx,
    ["booking", section.catalog_path === undefined ? "resource_kind" : "catalog_path"],
    catalogPath,
    needs,
  );
}

function typeCompatible(schema: JsonSchema, expected: JsonType): boolean {
  if (expected === "number") return schema.type === "number" || schema.type === "integer";
  return schema.type === expected;
}

function describeType(schema: JsonSchema): string {
  return typeof schema.type === "string" ? `a ${schema.type}` : "untyped";
}

/** A catalog is a config array of objects with `key`, `name` and any extra needed fields. */
function checkCatalog(
  ctx: CheckContext,
  path: DocPath,
  catalogPath: string,
  needs: readonly string[],
): JsonSchema | null {
  if (!ctx.config) return null;
  const schema = configFieldSchema(ctx, catalogPath);
  const items = schema?.type === "array" && isObject(schema.items) ? schema.items : null;
  if (!items || items.type !== "object" || !isObject(items.properties)) {
    ctx.issues.error(path, `catalog "${catalogPath}" must be a config_schema array of objects`);
    return null;
  }
  for (const field of ["key", "name", ...needs]) {
    if (!(field in items.properties)) {
      ctx.issues.error(path, `catalog "${catalogPath}" items need a "${field}" property`);
    }
  }
  return items;
}

/** Price guard: the catalog and its price fields exist with the right types. */
export function checkPriceGuard(ctx: CheckContext): void {
  const guard = ctx.template.guardrails.price_guard;
  const path: DocPath = ["guardrails", "price_guard"];
  const items = checkCatalog(ctx, [...path, "catalog_path"], guard.catalog_path, []);
  if (!items || !isObject(items.properties)) return;

  const price = items.properties[guard.price_field];
  if (!isObject(price) || price.type !== "integer") {
    ctx.issues.error(
      [...path, "price_field"],
      `"${guard.price_field}" must be an integer property of the catalog items`,
    );
  }
  if (guard.price_type_field !== undefined) {
    const type = items.properties[guard.price_type_field];
    const values = isObject(type) && Array.isArray(type.enum) ? type.enum : null;
    const unknown = values?.filter((v) => !(PRICE_TYPES as readonly unknown[]).includes(v)) ?? [];
    if (!values) {
      ctx.issues.error(
        [...path, "price_type_field"],
        `"${guard.price_type_field}" must be an enum property of the catalog items`,
      );
    } else if (unknown.length > 0) {
      ctx.issues.error(
        [...path, "price_type_field"],
        `has values the price guard doesn't understand: ${unknown.join(", ")} (known: ${PRICE_TYPES.join(", ")})`,
      );
    }
  }
}

/** Rule 10: every template regex compiles with `iu` and avoids ASCII-only \b traps. */
export function checkRegexes(ctx: CheckContext): void {
  const check = (path: DocPath, source: string) => {
    const problem = checkTemplateRegex(source);
    if (problem) ctx.issues.error(path, problem);
  };
  ctx.template.consent.accept_patterns.forEach((p, i) =>
    check(["consent", "accept_patterns", i], p),
  );
  ctx.template.guardrails.emergency.patterns.forEach((p, i) =>
    check(["guardrails", "emergency", "patterns", i], p),
  );
  ctx.template.evals.forEach((scenario, i) =>
    scenario.assert.reply_not_matches?.forEach((p, j) =>
      check(["evals", i, "assert", "reply_not_matches", j], p),
    ),
  );
}

/** Rule 5 (agent side): prompts and replies render strictly against sample data. */
export function checkAgentLiquid(ctx: CheckContext): void {
  const samples = ctx.samples;
  if (!samples) return;
  const { agent, consent, guardrails } = ctx.template;
  checkLiquid(ctx, ["agent", "system_prompt"], agent.system_prompt, samples.system);
  checkLiquid(ctx, ["agent", "facts_template"], agent.facts_template, samples.system);
  checkLiquid(ctx, ["agent", "dynamic_context"], agent.dynamic_context, samples.conversation);
  checkLiquid(ctx, ["agent", "handoff_reply"], agent.handoff_reply, samples.conversation);
  checkLiquid(ctx, ["agent", "fallback_reply"], agent.fallback_reply, samples.conversation);
  checkLiquid(ctx, ["agent", "unsupported_media"], agent.unsupported_media, samples.conversation);
  checkLiquid(ctx, ["consent", "message"], consent.message, samples.conversation);
  checkLiquid(
    ctx,
    ["guardrails", "emergency", "reply"],
    guardrails.emergency.reply,
    samples.conversation,
  );
  checkLiquid(ctx, ["guardrails", "opt_out_reply"], guardrails.opt_out_reply, samples.conversation);
}
