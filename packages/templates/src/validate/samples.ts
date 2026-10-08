import { DateTime } from "luxon";
import type { SubjectType } from "../capabilities.ts";
import {
  agentSettings,
  buildBookingContext,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  getPath,
  resolveBookingRules,
  type BookingFacts,
  type BookingRules,
  type Context,
} from "../context.ts";
import { isObject, type JsonSchema } from "../json-schema/platform-types.ts";
import { DEFAULT_TIMEZONE } from "../liquid.ts";
import type { Template } from "../meta-schema.ts";

/** Spec §11: evals default to this clock (a Monday), so samples use it too. */
export const SAMPLE_CLOCK = "2026-10-05T09:00:00-05:00";

export interface Samples {
  rules: BookingRules | null;
  /** Each Liquid string is rendered against every context in its list. */
  system: Context[];
  conversation: Context[];
  automation: Record<SubjectType, Context[]>;
}

/**
 * Sample contexts for validation, built with the same builders the runtime uses. Two
 * contacts — one with every field set, one with nothing — exercise both branches of
 * `{% if contact.name %}`-style conditionals.
 */
export function buildSamples(
  template: Template,
  configSchema: JsonSchema,
  sampleConfig: Record<string, unknown>,
  contactFieldsSchema: JsonSchema | null,
): Samples {
  const zone = DEFAULT_TIMEZONE;
  const now = DateTime.fromISO(SAMPLE_CLOCK).setZone(zone);
  const business = buildBusinessContext(sampleConfig, configSchema, zone);
  const rules = template.booking ? resolveBookingRules(template.booking, sampleConfig) : null;
  const bookingFacts = sampleBooking(sampleConfig, rules, now);

  const fieldProps = isObject(contactFieldsSchema?.properties)
    ? contactFieldsSchema.properties
    : {};
  const fieldKeys = Object.keys(fieldProps);
  const richContact = buildContactContext(
    {
      name: "Laura Gómez",
      fields: Object.fromEntries(Object.entries(fieldProps).map(([k, s]) => [k, sampleValue(s)])),
      upcomingBookings: [bookingFacts],
    },
    fieldKeys,
  );
  const sparseContact = buildContactContext(
    { name: null, fields: {}, upcomingBookings: [] },
    fieldKeys,
  );

  const system: Context = { business, agent: agentSettings(template) };
  if (rules) system.booking = rules;
  const nowContext = buildNowContext(now);
  const conversation = [richContact, sparseContact].map((contact) => ({
    ...system,
    now: nowContext,
    contact,
  }));

  const base = [richContact, sparseContact].map((contact) => ({
    business,
    now: nowContext,
    contact,
  }));
  const booking = buildBookingContext(bookingFacts);
  return {
    rules,
    system: [system],
    conversation,
    automation: {
      booking: base.map((ctx) => ({ ...ctx, booking })),
      contact: base,
      conversation: base,
      business: [{ business, now: nowContext }],
    },
  };
}

/** Tomorrow 10:00 for the first bookable catalog item (or a generic service). */
function sampleBooking(
  config: Record<string, unknown>,
  rules: BookingRules | null,
  now: DateTime,
): BookingFacts {
  const catalog = rules ? getPath(config, rules.catalog_path) : undefined;
  const items = Array.isArray(catalog) ? catalog.filter(isObject) : [];
  const service = items.find((item) => item.bookable !== false) ?? {};
  const duration =
    typeof service.duration_min === "number"
      ? service.duration_min
      : typeof rules?.fixed_duration_min === "number"
        ? rules.fixed_duration_min
        : 30;
  const start = now.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  return {
    id: "00000000-0000-4000-8000-000000000001",
    service_key: typeof service.key === "string" ? service.key : "servicio",
    service_name: typeof service.name === "string" ? service.name : "Servicio",
    subject_name: "Laura Gómez",
    party_size: 2,
    status: "pending",
    source: "agent",
    starts_at: start,
    ends_at: start.plus({ minutes: duration }),
    resource_name: "Recurso 1",
    notes: null,
  };
}

/** A plausible value for a contact field schema. */
export function sampleValue(schema: unknown): unknown {
  if (!isObject(schema)) return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if ("const" in schema) return schema.const;
  switch (schema.type) {
    case "string":
      if (schema.format === "date") return "2026-04-05";
      if (schema.format === "date-time") return "2026-04-05T10:00:00-05:00";
      return "Ejemplo";
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return [];
    default:
      return null;
  }
}
