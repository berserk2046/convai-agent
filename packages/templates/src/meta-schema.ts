import { z } from "zod";
import {
  BOOKING_REQUIRED,
  BOOKING_RULES,
  BUILTIN_CONDITIONS,
  CONFIGURABLE_BOOKING_RULES,
  WA_CATEGORIES,
  WA_LANGUAGES,
  WA_LIMITS,
  slug,
} from "./capabilities.ts";
import { isSemver } from "./semver.ts";

/**
 * Shape of a vertical template (spec §10). Structural only: cross-references (tools,
 * triggers, Liquid variables, field paths…) are checked by the validator afterwards, so
 * those errors can name the exact problem instead of "invalid input".
 */

const text = z.string().trim().min(1, "must not be empty");
/** Liquid source; rendered and checked by the validator. */
const liquid = text;
/** Regex source; compiled with the `iu` flags by the validator. */
const pattern = text;
const semver = z.string().refine(isSemver, "must be a semantic version like 1.0.0");
const jsonObject = z.record(z.string(), z.unknown());

/** A dotted path into a render context: "contact.name", "booking.service_name". */
export const contextPath = z
  .string()
  .regex(
    /^(business|contact|booking|now)(\.[a-z_][a-z0-9_]*)+$/,
    'must be a path like "contact.name" or "booking.service_name"',
  );

const manifest = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9_-]*$/, "must be lowercase letters, digits, - or _"),
  name: text,
  version: semver,
  locale: z.enum(["es-CO"]),
  min_platform_version: semver,
  description: text,
  capabilities: z.strictObject({
    tools: z.array(z.string()).default([]),
    triggers: z.array(z.string()).default([]),
  }),
});

const consent = z.strictObject({
  message: liquid,
  accept_patterns: z.array(pattern).min(1),
  allow_faq_before_consent: z.boolean(),
});

/** Booking rules; each configurable rule can come from config via `<rule>_config`. */
const booking = z
  .strictObject({
    ...Object.fromEntries(Object.entries(BOOKING_RULES).map(([k, s]) => [k, s.optional()])),
    ...Object.fromEntries(
      Object.keys(CONFIGURABLE_BOOKING_RULES).map((k) => [
        `${k}_config`,
        z.string().min(1).optional(),
      ]),
    ),
  })
  .superRefine((rules, ctx) => {
    for (const key of Object.keys(BOOKING_RULES)) {
      const hasValue = rules[key] !== undefined;
      const hasRef = rules[`${key}_config`] !== undefined;
      if (hasValue && hasRef) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `set ${key} or ${key}_config, not both`,
        });
      } else if (!hasValue && !hasRef && BOOKING_REQUIRED.includes(key as never)) {
        const alt = key in CONFIGURABLE_BOOKING_RULES ? ` (or ${key}_config)` : "";
        ctx.addIssue({ code: "custom", path: [key], message: `is required${alt}` });
      }
    }
    if (
      rules.duration_from === "fixed" &&
      rules.fixed_duration_min === undefined &&
      rules.fixed_duration_min_config === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fixed_duration_min"],
        message: 'is required when duration_from is "fixed"',
      });
    }
  });

const agent = z.strictObject({
  model: z
    .string()
    .regex(/^claude-[a-z0-9-]+$/, 'must be a Claude model id like "claude-haiku-4-5-20251001"'),
  max_reply_words: z.number().int().min(10).max(300),
  max_tool_calls_per_turn: z.number().int().min(1).max(20),
  history_messages: z.number().int().min(1).max(100),
  /** Tool name → server-bound params; names and params are checked by the validator. */
  tools: z.record(z.string(), jsonObject),
  system_prompt: liquid,
  facts_template: liquid,
  dynamic_context: liquid,
  handoff_reply: liquid,
  fallback_reply: liquid,
  unsupported_media: liquid,
});

const guardrails = z.strictObject({
  price_guard: z.strictObject({
    enabled: z.boolean(),
    catalog_path: text,
    price_field: text,
    price_type_field: text.optional(),
  }),
  emergency: z.strictObject({
    patterns: z.array(pattern).min(1),
    reply: liquid,
    handoff_reason: slug,
  }),
  opt_out_keywords: z.array(text).min(1),
  opt_out_reply: liquid,
});

/** A message variable: one path, or the first non-empty of several plus a literal fallback. */
const waVariable = z.union([
  contextPath,
  z.strictObject({ paths: z.array(contextPath).min(1), fallback: text.optional() }),
]);

const waTemplate = z.strictObject({
  key: slug,
  category: z.enum(WA_CATEGORIES),
  language: z.enum(WA_LANGUAGES, {
    error: "is not a language code Meta supports (e.g. es, es_CO, en_US)",
  }),
  body: text.max(
    WA_LIMITS.bodyMaxChars,
    `must be at most ${WA_LIMITS.bodyMaxChars} characters (Meta limit)`,
  ),
  variables: z.array(waVariable).default([]),
  examples: z.array(z.string()).default([]),
  buttons: z
    .array(
      z.strictObject({
        type: z.literal("QUICK_REPLY"),
        text: text.max(
          WA_LIMITS.buttonTextMaxChars,
          `must be at most ${WA_LIMITS.buttonTextMaxChars} characters (Meta limit)`,
        ),
        payload: slug,
      }),
    )
    .max(
      WA_LIMITS.maxQuickReplies,
      `at most ${WA_LIMITS.maxQuickReplies} quick replies (Meta limit)`,
    )
    .default([]),
});

/** `{ type, ...params }`; params are checked against the action registry. */
const action = z.looseObject({ type: z.string() });

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const condition = z
  .strictObject({
    field: z.string().optional(),
    eq: scalar.optional(),
    in: z.array(scalar).min(1).optional(),
    exists: z.literal(true).optional(),
    not_exists: z.literal(true).optional(),
    builtin: z.enum(BUILTIN_CONDITIONS).optional(),
    rule: slug.optional(),
  })
  .superRefine((c, ctx) => {
    const ops = (["eq", "in", "exists", "not_exists"] as const).filter((op) => c[op] !== undefined);
    if (c.builtin !== undefined) {
      if (c.field !== undefined || ops.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["builtin"],
          message: "can't be combined with field comparisons",
        });
      }
      if ((c.builtin === "run_sent") !== (c.rule !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["rule"],
          message: "is required with run_sent, and only with it",
        });
      }
    } else if (c.field === undefined) {
      ctx.addIssue({ code: "custom", path: ["field"], message: "is required (or use builtin)" });
    } else if (ops.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["field"],
        message: "needs exactly one of eq, in, exists, not_exists",
      });
    }
  });

const automation = z.strictObject({
  key: slug,
  description: text,
  default_enabled: z.boolean(),
  /** `{ type, ...params }`; params are checked against the trigger registry. */
  trigger: z.looseObject({ type: z.string() }),
  conditions: z.array(condition).default([]),
  action,
  on_button: z.record(slug, z.array(action).min(1)).optional(),
  overridable: z.array(z.string()).optional(),
});

const isoWithOffset = z.iso.datetime({
  offset: true,
  error: "must be an ISO date-time with offset, e.g. 2026-10-05T09:00:00-05:00",
});

const evalTurn = z
  .strictObject({ user: text.optional(), expect_tool: z.string().optional() })
  .refine((t) => (t.user === undefined) !== (t.expect_tool === undefined), {
    message: "must have exactly one of user or expect_tool",
  });

const evalAssert = z
  .strictObject({
    tool_called: z.string().optional(),
    no_tool: z.array(z.string()).min(1).optional(),
    booking_created: z
      .strictObject({
        service_key: z.string(),
        local_date: z.iso.date(),
        local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:mm"'),
      })
      .optional(),
    bookings_count: z.number().int().min(0).optional(),
    handoff: z.strictObject({ reason: z.string() }).optional(),
    no_handoff: z.literal(true).optional(),
    reply_contains: z.array(text).min(1).optional(),
    reply_not_matches: z.array(pattern).min(1).optional(),
    reply_contains_price: z.strictObject({ service_key: z.string() }).optional(),
    judge: text.optional(),
  })
  .refine((a) => Object.keys(a).length > 0, {
    message: "needs at least one assertion",
  });

const evalScenario = z.strictObject({
  id: slug,
  critical: z.boolean(),
  clock: isoWithOffset.optional(),
  consent: z.literal("pending").optional(),
  fixtures: z
    .strictObject({
      bookings: z
        .array(
          z.strictObject({
            service_key: z.string(),
            starts_at: isoWithOffset,
            subject_name: text,
            status: z.enum(["pending", "confirmed"]).optional(),
          }),
        )
        .optional(),
      contact: z.strictObject({ name: text.optional(), fields: jsonObject.optional() }).optional(),
    })
    .optional(),
  turns: z.array(evalTurn).min(1),
  assert: evalAssert,
});

const evalFixtures = z.strictObject({
  resources: z
    .array(z.strictObject({ kind: slug, name: text, capacity: z.number().int().min(1).optional() }))
    .optional(),
});

export const templateSchema = z.strictObject({
  manifest,
  config_schema: jsonObject,
  contact_fields: z.record(z.string(), jsonObject).optional(),
  consent,
  booking: booking.optional(),
  agent,
  guardrails,
  wa_templates: z.array(waTemplate).default([]),
  automations: z.array(automation).default([]),
  evals: z.array(evalScenario).min(1),
  sample_config: jsonObject,
  eval_fixtures: evalFixtures.optional(),
});

export type Template = z.output<typeof templateSchema>;
export type WaTemplate = Template["wa_templates"][number];
export type WaVariable = WaTemplate["variables"][number];
export type Automation = Template["automations"][number];
export type AutomationAction = Automation["action"];
export type Condition = Automation["conditions"][number];
export type EvalScenario = Template["evals"][number];
export type BookingSection = NonNullable<Template["booking"]>;
