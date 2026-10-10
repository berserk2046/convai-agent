import { z } from "zod";

/**
 * Everything a template can switch on. Templates enable and parameterize these; the
 * implementations live in core (tools) and automations (triggers, actions, conditions) and
 * must cover every name declared here. Templates can never add to this list (principle 2).
 */

export const PLATFORM_VERSION = "0.1.0";

export const slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "must be lowercase letters, digits and underscores, starting with a letter",
  );

const int = (min: number, max: number) => z.number().int().min(min).max(max);

// ---------------------------------------------------------------------------------------
// Booking rules (template `booking` section; also overridable per booking tool)

export const BOOKING_COLLECT_FIELDS = ["subject_name", "party_size", "notes"] as const;

/** Booking rules and their value schemas. Every key is optional here; see BOOKING_REQUIRED. */
export const BOOKING_RULES = {
  resource_kind: slug,
  resource_label: z.string().trim().min(1),
  duration_from: z.enum(["service", "fixed"]),
  fixed_duration_min: z.number().int().min(5).multipleOf(5),
  buffer_min: int(0, 240),
  max_days_ahead: int(1, 365),
  min_notice_hours: int(0, 720),
  slots_to_offer: int(1, 5),
  require_explicit_confirmation: z.boolean(),
  collect: z.array(z.enum(BOOKING_COLLECT_FIELDS)),
  catalog_path: z.string().min(1),
} as const;

export type BookingRuleKey = keyof typeof BOOKING_RULES;

export const BOOKING_REQUIRED: readonly BookingRuleKey[] = [
  "resource_kind",
  "resource_label",
  "duration_from",
  "buffer_min",
  "max_days_ahead",
  "min_notice_hours",
  "slots_to_offer",
  "require_explicit_confirmation",
  "collect",
];

/** Rules a template may take from the business config with `<key>_config: <field>`. */
export const CONFIGURABLE_BOOKING_RULES: Readonly<Partial<Record<BookingRuleKey, JsonType>>> = {
  fixed_duration_min: "integer",
  buffer_min: "integer",
  max_days_ahead: "integer",
  min_notice_hours: "integer",
  slots_to_offer: "integer",
  require_explicit_confirmation: "boolean",
};

export type JsonType = "string" | "integer" | "number" | "boolean" | "array" | "object";

/** Without `booking.catalog_path`, services are read from this config field. */
export const DEFAULT_CATALOG_PATH = "services";

/** Price types the price guard understands (values of the catalog's price_type field). */
export const PRICE_TYPES = ["fixed", "from", "after_evaluation"] as const;

// ---------------------------------------------------------------------------------------
// Tools (spec §7). `params` are server-bound: the model never sees them.

export interface ToolDeclaration {
  params: z.ZodType;
  /** Booking tools need the template's `booking` section. */
  usesBookingRules: boolean;
  /** Disabled until the contact gives consent (spec §7, step 3). */
  requiresConsent: boolean;
}

const bookingOverrides = (keys: readonly BookingRuleKey[]) =>
  z.strictObject(Object.fromEntries(keys.map((k) => [k, BOOKING_RULES[k].optional()])));

export const TOOLS = {
  lookup_catalog: {
    params: z.strictObject({ catalog_path: z.string().min(1) }),
    usesBookingRules: false,
    requiresConsent: false,
  },
  check_availability: {
    params: bookingOverrides([
      "resource_kind",
      "duration_from",
      "buffer_min",
      "max_days_ahead",
      "min_notice_hours",
      "slots_to_offer",
    ]),
    usesBookingRules: true,
    requiresConsent: false,
  },
  book: {
    params: bookingOverrides(["require_explicit_confirmation", "collect"]),
    usesBookingRules: true,
    requiresConsent: true,
  },
  find_bookings: { params: z.strictObject({}), usesBookingRules: false, requiresConsent: false },
  reschedule: {
    params: bookingOverrides(["require_explicit_confirmation", "collect"]),
    usesBookingRules: true,
    requiresConsent: true,
  },
  cancel: {
    params: z.strictObject({ require_confirmation: z.boolean().optional() }),
    usesBookingRules: true,
    requiresConsent: true,
  },
  handoff: {
    params: z.strictObject({
      reasons: z.array(slug).min(1),
      /** What staff read for each reason in the admin; reasons without one show humanized. */
      labels: z.record(z.string(), z.string().min(1)).optional(),
    }),
    usesBookingRules: false,
    requiresConsent: false,
  },
  update_contact: {
    params: z.strictObject({ writable_fields: z.array(z.string()).min(1) }),
    usesBookingRules: false,
    requiresConsent: true,
  },
} as const satisfies Record<string, ToolDeclaration>;

export type ToolName = keyof typeof TOOLS;

/** Handoff reasons the runtime itself uses; every template must allow them. */
export const SYSTEM_HANDOFF_REASONS = ["error", "price_guard", "budget"] as const;

// ---------------------------------------------------------------------------------------
// Automations (spec §9)

export type SubjectType = "booking" | "contact" | "conversation" | "business";

/** "-24h", "2h", "180d", "30m" */
const DURATION = /^(-?)(\d+)(m|h|d)$/;

export function parseDurationMinutes(value: string): number | null {
  const m = DURATION.exec(value);
  if (!m) return null;
  const unit = m[3] === "d" ? 1440 : m[3] === "h" ? 60 : 1;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * unit;
}

const duration = (check: (minutes: number) => boolean, rule: string) =>
  z
    .string()
    .regex(DURATION, 'must look like "30m", "24h" or "180d" (minus sign for "before")')
    .refine((v) => check(parseDurationMinutes(v) ?? 0), rule);

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const localTime = z.string().regex(HHMM, 'must be a local time like "10:00"');

/** Five cron fields: numbers, ranges, steps, lists or "*". */
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
const cron = z.string().refine((v) => {
  const fields = v.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}, 'must be a 5-field cron expression like "0 9 * * 1"');

export interface TriggerDeclaration {
  subject: SubjectType;
  params: z.ZodType;
}

export const TRIGGERS = {
  "booking.created": { subject: "booking", params: z.strictObject({}) },
  "booking.rescheduled": { subject: "booking", params: z.strictObject({}) },
  "booking.cancelled": { subject: "booking", params: z.strictObject({}) },
  "booking.starts_in": {
    subject: "booking",
    params: z.strictObject({ offset: duration((m) => m < 0, 'must be negative, e.g. "-24h"') }),
  },
  "booking.completed": {
    subject: "booking",
    params: z.strictObject({ offset: duration((m) => m >= 0, "must be zero or positive") }),
  },
  "contact.date_field": {
    subject: "contact",
    params: z.strictObject({
      field: z.string().min(1),
      offset: duration(() => true, ""),
      at_local_time: localTime,
    }),
  },
  "conversation.inactive": {
    subject: "conversation",
    params: z.strictObject({ duration: duration((m) => m > 0, "must be positive") }),
  },
  schedule: { subject: "business", params: z.strictObject({ cron }) },
} as const satisfies Record<string, TriggerDeclaration>;

export type TriggerType = keyof typeof TRIGGERS;

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;

export interface ActionDeclaration {
  params: z.ZodType;
  /** Subjects the action works on; omitted means any. */
  subjects?: readonly SubjectType[];
  /** Param names holding Liquid text, rendered with the automation context. */
  liquidParams: readonly string[];
}

export const AGENT_INTENTS = ["book", "reschedule", "cancel", "general"] as const;

export const ACTIONS = {
  send_template: { params: z.strictObject({ template: slug }), liquidParams: [] },
  send_text: { params: z.strictObject({ text: z.string().min(1) }), liquidParams: ["text"] },
  update_booking: {
    params: z.strictObject({
      set: z.strictObject({ status: z.enum(["confirmed", "cancelled"]) }),
    }),
    subjects: ["booking"],
    liquidParams: [],
  },
  update_contact: {
    params: z.strictObject({ set: z.record(z.string(), z.unknown()) }),
    liquidParams: [],
  },
  notify_staff: { params: z.strictObject({ text: z.string().min(1) }), liquidParams: ["text"] },
  start_agent: { params: z.strictObject({ intent: z.enum(AGENT_INTENTS) }), liquidParams: [] },
} as const satisfies Record<string, ActionDeclaration>;

export type ActionType = keyof typeof ACTIONS;

/** Built-in conditions. `not_opted_out` and `has_consent` are always applied anyway. */
export const BUILTIN_CONDITIONS = [
  "not_opted_out",
  "has_consent",
  "quiet_hours",
  "no_future_booking",
  "run_sent",
] as const;

// ---------------------------------------------------------------------------------------
// WhatsApp (Meta) message templates

export const WA_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;

/** Meta's supported template language codes (checked against Meta's docs, 2026-10). */
// prettier-ignore
export const WA_LANGUAGES = [
  "af", "sq", "ar", "ar_EG", "ar_AE", "ar_LB", "ar_MA", "ar_QA", "az", "be_BY", "bn", "bn_IN",
  "bg", "ca", "zh_CN", "zh_HK", "zh_TW", "hr", "cs", "da", "prs_AF", "nl", "nl_BE", "en", "en_GB",
  "en_US", "en_AE", "en_AU", "en_CA", "en_GH", "en_IE", "en_IN", "en_JM", "en_MY", "en_NZ",
  "en_QA", "en_SG", "en_UG", "en_ZA", "et", "fil", "fi", "fr", "fr_BE", "fr_CA", "fr_CH", "fr_CI",
  "fr_MA", "ka", "de", "de_AT", "de_CH", "el", "gu", "ha", "he", "hi", "hu", "id", "ga", "it",
  "ja", "kn", "kk", "rw_RW", "ko", "ky_KG", "lo", "lv", "lt", "mk", "ms", "ml", "mr", "nb",
  "ps_AF", "fa", "pl", "pt_BR", "pt_PT", "pa", "ro", "ru", "sr", "si_LK", "sk", "sl", "es",
  "es_AR", "es_CL", "es_CO", "es_CR", "es_DO", "es_EC", "es_HN", "es_MX", "es_PA", "es_PE",
  "es_ES", "es_UY", "sw", "sv", "ta", "te", "th", "tr", "uk", "ur", "uz", "vi", "zu",
] as const;

/** Meta limits (template components and review docs). */
export const WA_LIMITS = {
  bodyMaxChars: 1024,
  buttonTextMaxChars: 25,
  maxQuickReplies: 10,
  nameMaxChars: 512,
} as const;
