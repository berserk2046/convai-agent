import {
  WEEKDAY_KEYS,
  buildCalendar,
  formatDayLabel,
  formatNowLong,
  formatRanges,
  formatSlotLabel,
  formatTime,
  weekdayKeyName,
  type CalendarDay,
} from "@platform/shared";
import type { DateTime } from "luxon";
import { DEFAULT_CATALOG_PATH, type BookingRuleKey } from "./capabilities.ts";
import { PLATFORM_TYPE_KEYWORD, isObject, type JsonSchema } from "./json-schema/platform-types.ts";
import type { BookingSection, Template } from "./meta-schema.ts";

/**
 * Builders for the variables templates can use (Appendix B, docs/templates.md). Both the
 * validator (with sample data) and the runtime (with real data) use these, so a template
 * that validates sees exactly the same shapes in production.
 *
 * Contexts:
 * - system (cached prompt block): business, agent, booking (= booking rules)
 * - conversation (dynamic context, replies): system + now + contact
 * - automation (texts, update values, message variables): business, contact, now, and
 *   booking (= the booking subject) when the trigger's subject is a booking
 */

export type Context = Record<string, unknown>;

// --- business ------------------------------------------------------------------------

/**
 * The business config as templates see it: every property the schema declares is present
 * (absent optional values become null, absent arrays []), plus computed fields:
 * `<field>_list` for each platform:weekly_hours field, and `timezone`.
 */
export function buildBusinessContext(
  config: Record<string, unknown>,
  configSchema: JsonSchema,
  timezone: string,
): Context {
  const business = fillDeclared(config, configSchema) as Context;
  const properties = isObject(configSchema.properties) ? configSchema.properties : {};
  for (const [key, schema] of Object.entries(properties)) {
    if (isObject(schema) && schema[PLATFORM_TYPE_KEYWORD] === "weekly_hours") {
      business[`${key}_list`] = weeklyHoursList(config[key]);
    }
  }
  business.timezone = timezone;
  return business;
}

/** Names the business context adds on top of the config; config fields can't use them. */
export function computedBusinessKeys(configSchema: JsonSchema): string[] {
  const properties = isObject(configSchema.properties) ? configSchema.properties : {};
  const weekly = Object.entries(properties)
    .filter(([, s]) => isObject(s) && s[PLATFORM_TYPE_KEYWORD] === "weekly_hours")
    .map(([key]) => `${key}_list`);
  return [...weekly, "timezone"];
}

function weeklyHoursList(hours: unknown) {
  const week = isObject(hours) ? hours : {};
  return WEEKDAY_KEYS.map((key) => {
    const ranges = Array.isArray(week[key]) ? (week[key] as { open: string; close: string }[]) : [];
    const name = weekdayKeyName(key);
    return {
      key,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      ranges: formatRanges(ranges),
      closed: ranges.length === 0,
    };
  });
}

/** Fills every declared property that is missing: objects recursively, arrays [], else null. */
function fillDeclared(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value ?? null;
  if (value === undefined || value === null) {
    if (schema.type === "array") return [];
    if (schema.type === "object" && isObject(schema.properties)) return fillDeclared({}, schema);
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillDeclared(item, schema.items));
  }
  if (isObject(value) && isObject(schema.properties)) {
    const out: Context = { ...value };
    for (const [key, sub] of Object.entries(schema.properties)) {
      out[key] = fillDeclared(value[key], sub);
    }
    return out;
  }
  return value;
}

// --- booking rules -----------------------------------------------------------------------

export type BookingRules = Record<BookingRuleKey, unknown> & { catalog_path: string };

/** Booking rules with every `<rule>_config` reference read from the business config. */
export function resolveBookingRules(
  section: BookingSection,
  config: Record<string, unknown>,
): BookingRules {
  const rules: Context = {};
  for (const [key, value] of Object.entries(section)) {
    if (key.endsWith("_config") && typeof value === "string") {
      rules[key.slice(0, -"_config".length)] = getPath(config, value) ?? null;
    } else {
      rules[key] = value;
    }
  }
  rules.catalog_path ??= DEFAULT_CATALOG_PATH;
  return rules as BookingRules;
}

// --- agent ---------------------------------------------------------------------------------

export function agentSettings(template: Template): Context {
  const { model, max_reply_words, max_tool_calls_per_turn, history_messages } = template.agent;
  return { model, max_reply_words, max_tool_calls_per_turn, history_messages };
}

// --- now -------------------------------------------------------------------------------------

export interface NowContext {
  iso: string;
  date: string;
  time: string;
  long: string;
  calendar: CalendarDay[];
}

/**
 * `now` must already be in the business timezone. `openHolidays`: keys of the public
 * holidays the business opens on (spec review C2); the calendar marks the others closed.
 */
export function buildNowContext(now: DateTime, openHolidays: readonly string[] = []): NowContext {
  return {
    iso: now.toISO() ?? "",
    date: now.toISODate() ?? "",
    time: formatTime(now.hour, now.minute),
    long: formatNowLong(now),
    calendar: buildCalendar(now, { openHolidays }),
  };
}

// --- bookings and contacts ---------------------------------------------------------------

export interface BookingFacts {
  id: string;
  service_key: string;
  service_name: string;
  subject_name: string;
  party_size: number | null;
  status: string;
  source: string;
  /** In the business timezone. */
  starts_at: DateTime;
  ends_at: DateTime;
  resource_name: string | null;
  notes: string | null;
}

/** Fields of `booking` in automation contexts (and conditions on `booking.*`). */
export const BOOKING_CONTEXT_FIELDS = [
  "id",
  "service_key",
  "service_name",
  "subject_name",
  "party_size",
  "status",
  "source",
  "starts_at",
  "ends_at",
  "label",
  "date_long",
  "time",
  "local_date",
  "resource_name",
  "notes",
] as const;

export function buildBookingContext(booking: BookingFacts): Context {
  const { starts_at: start } = booking;
  return {
    id: booking.id,
    service_key: booking.service_key,
    service_name: booking.service_name,
    subject_name: booking.subject_name,
    party_size: booking.party_size,
    status: booking.status,
    source: booking.source,
    starts_at: start.toISO(),
    ends_at: booking.ends_at.toISO(),
    label: formatSlotLabel(start),
    date_long: formatDayLabel(start),
    time: formatTime(start.hour, start.minute),
    local_date: start.toISODate(),
    resource_name: booking.resource_name,
    notes: booking.notes,
  };
}

export interface ContactFacts {
  name: string | null;
  fields: Record<string, unknown>;
  upcomingBookings: BookingFacts[];
}

/** Contact names the platform itself provides; contact_fields can't reuse them. */
export const RESERVED_CONTACT_KEYS = [
  "name",
  "upcoming_bookings",
  "id",
  "wa_number",
  "wa_profile_name",
  "fields",
  "consent_at",
  "opted_out_at",
  "created_at",
] as const;

/** `contact.*`: name, every declared contact field (null when unset), upcoming bookings. */
export function buildContactContext(contact: ContactFacts, fieldKeys: readonly string[]): Context {
  const fields = Object.fromEntries(fieldKeys.map((key) => [key, contact.fields[key] ?? null]));
  return {
    ...fields,
    name: contact.name,
    upcoming_bookings: contact.upcomingBookings.map((b) => {
      const ctx = buildBookingContext(b);
      return {
        id: ctx.id,
        service_key: ctx.service_key,
        service_name: ctx.service_name,
        subject_name: ctx.subject_name,
        status: ctx.status,
        starts_at: ctx.starts_at,
        label: ctx.label,
      };
    }),
  };
}

// --- helpers -----------------------------------------------------------------------------

/** Reads "a.b.c" from nested objects; undefined when any step is missing. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}
