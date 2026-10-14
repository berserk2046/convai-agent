import {
  chooseSlots,
  nearbyDays,
  timeOfDayAt,
  toMinutes,
  type NearbyDay,
  type TimeOfDay,
} from "@platform/scheduling";
import { formatDayLabel } from "@platform/shared";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  catalogAt,
  describeItem,
  findItem,
  isBookable,
  searchCatalog,
  slotView,
} from "./catalog.ts";
import {
  closedHolidays,
  durationOf,
  effectiveRules,
  searchSlots,
  type SlotSearch,
} from "./slots.ts";
import { toolError, type AgentTool, type ToolContext } from "./types.ts";

const isoDate = z.iso
  .date()
  .describe('Local date, "YYYY-MM-DD". Take it from the calendar in the context.');

export const lookupCatalog: AgentTool = {
  name: "lookup_catalog",
  description:
    "Look up the business's services or items: name, price_type, price_cop, duration and description. " +
    "Use it before stating any price or service detail. Search by `query` (words) or exact `key`; " +
    "with neither, returns the whole catalog.",
  input: () =>
    z.strictObject({
      query: z.string().max(100).optional().describe("Words to search for, e.g. 'limpieza'"),
      key: z.string().max(60).optional().describe("Exact item key, if known"),
    }),
  run(ctx, input, params) {
    const catalog = catalogAt(ctx.config, String(params.catalog_path));
    const key = typeof input.key === "string" ? input.key : undefined;
    const query = typeof input.query === "string" ? input.query : undefined;
    const items = key
      ? [findItem(catalog, key)].filter((i) => i !== null)
      : searchCatalog(catalog, query ?? "");
    return Promise.resolve({
      result: { items: items.slice(0, 15).map(describeItem), total: items.length },
    });
  },
};

export const checkAvailability: AgentTool = {
  name: "check_availability",
  description:
    "Find free appointment times for a service between two local dates (inclusive). Always call this " +
    "before offering times. Returns a few well-spread options. If the customer asks for a specific time, " +
    "pass `around_time`: the result says whether exactly that time is free (`exact`) and lists the " +
    "nearest alternatives. When nothing is free on the asked dates, `nearby_days` lists the closest days " +
    "that have free times in the same part of the day. `booking_window` appears when the dates are later " +
    "than bookings open.",
  input: () =>
    z.strictObject({
      service_key: z.string().describe("Catalog key of the service"),
      date_from: isoDate,
      date_to: isoDate,
      time_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
      party_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of people, for reservations"),
      around_time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional()
        .describe('A specific local time the customer asked for, "HH:mm"'),
    }),
  async run(ctx, input, params) {
    const rules = effectiveRules(ctx, params);
    const catalog = catalogAt(ctx.config, rules.catalogPath);
    const item = findItem(catalog, String(input.service_key));
    if (!item)
      return toolError("unknown_service", "No service with that key.", {
        known_keys: catalog.map((i) => i.key),
      });
    if (!isBookable(item))
      return toolError(
        "not_bookable",
        "This service can't be booked over WhatsApp; offer a person (handoff) or a related bookable service.",
      );
    const durationMin = durationOf(item, rules);
    if (durationMin === null)
      return toolError("no_duration", "This service has no duration configured.");

    const timeOfDay = input.time_of_day as TimeOfDay | undefined;
    const partySize = typeof input.party_size === "number" ? input.party_size : undefined;
    const search = { item, rules, durationMin, timeOfDay, partySize };
    const dateFrom = String(input.date_from);
    const dateTo = String(input.date_to);
    const candidates = await searchSlots(ctx, { ...search, dateFrom, dateTo });
    const around = typeof input.around_time === "string" ? input.around_time : undefined;
    const offer = chooseSlots(candidates, rules.slotsToOffer, around);
    const holidays = closedHolidays(ctx, dateFrom, dateTo);
    const exact = offer.exact
      ? candidates.find((c) => c.day === offer.exact?.day && c.minute === offer.exact.minute)
      : undefined;
    const window = bookingWindow(ctx, rules.maxDaysAhead);
    const nearby =
      offer.slots.length === 0
        ? await nearbyFree(ctx, search, { dateFrom, dateTo, around, window })
        : [];
    return {
      result: {
        service: { key: item.key, name: item.name, duration_min: durationMin },
        slots: offer.slots.map((s) => slotView(s.start, ctx.timezone)),
        ...(offer.exact
          ? {
              exact: {
                time: around,
                available: offer.exact.available,
                ...(exact ? slotView(exact.start, ctx.timezone) : {}),
              },
            }
          : {}),
        ...(holidays.length > 0
          ? {
              closed_holidays: holidays.map((h) => ({
                date: h.date,
                name: h.name,
                note: "Public holiday: the business is closed.",
              })),
            }
          : {}),
        ...(dateTo > window.last
          ? {
              booking_window: {
                last_date: window.last,
                last_label: dayLabel(window.last, ctx.timezone),
                note:
                  `Appointments can only be booked up to ${String(rules.maxDaysAhead)} days ahead. ` +
                  "Later dates are not open yet; they are not full. Say so plainly.",
              },
            }
          : {}),
        ...(offer.slots.length === 0 ? emptyResult(nearby, ctx.timezone) : {}),
      },
    };
  },
};

// --- when the asked dates have nothing free (owner, 2026-10-11) -----------------------------

/** How many of the closest days with free times to offer, and how many times on each. */
const NEARBY_DAYS = 3;
const NEARBY_TIMES_PER_DAY = 2;
/** How far around the asked dates to look. */
const NEARBY_DAYS_BEFORE = 7;
const NEARBY_DAYS_AFTER = 14;

interface Window {
  first: string;
  last: string;
}

/** Local dates from today to the last one `max_days_ahead` allows. */
function bookingWindow(ctx: ToolContext, maxDaysAhead: number): Window {
  const today = DateTime.fromJSDate(ctx.now, { zone: ctx.timezone }).startOf("day");
  return {
    first: today.toISODate() ?? "",
    last: today.plus({ days: maxDaysAhead }).toISODate() ?? "",
  };
}

/**
 * The closest days around the asked dates (inside the booking window) with free times in
 * the same part of the day: the one asked for, or the one `around_time` falls in.
 */
async function nearbyFree(
  ctx: ToolContext,
  search: Omit<SlotSearch, "dateFrom" | "dateTo">,
  asked: { dateFrom: string; dateTo: string; around: string | undefined; window: Window },
): Promise<NearbyDay[]> {
  const { window } = asked;
  const clamp = (date: string) =>
    date < window.first ? window.first : date > window.last ? window.last : date;
  const shift = (date: string, days: number) =>
    DateTime.fromISO(date, { zone: ctx.timezone }).plus({ days }).toISODate() ?? date;
  const from =
    [window.first, shift(clamp(asked.dateFrom), -NEARBY_DAYS_BEFORE)].sort().at(-1) ?? window.first;
  const to = [window.last, shift(clamp(asked.dateTo), NEARBY_DAYS_AFTER)].sort()[0] ?? window.last;
  if (from > to) return [];
  const timeOfDay =
    search.timeOfDay ??
    (asked.around === undefined ? undefined : timeOfDayAt(toMinutes(asked.around)));
  const candidates = await searchSlots(ctx, { ...search, timeOfDay, dateFrom: from, dateTo: to });
  return nearbyDays(candidates, {
    from: asked.dateFrom,
    to: asked.dateTo,
    days: NEARBY_DAYS,
    perDay: NEARBY_TIMES_PER_DAY,
    ...(asked.around === undefined ? {} : { aroundTime: asked.around }),
  });
}

function emptyResult(nearby: readonly NearbyDay[], timezone: string): Record<string, unknown> {
  if (nearby.length === 0) {
    return {
      note: "Nothing free on the asked dates or the days around them. Ask for other dates, or offer a person (handoff).",
    };
  }
  return {
    note:
      "Nothing free on the asked dates. nearby_days are the closest days with free times in the same part " +
      "of the day: offer two or three of them in this same reply, without asking first.",
    nearby_days: nearby.map((d) => ({
      date: d.day,
      label: dayLabel(d.day, timezone),
      times: d.slots.map((c) => slotView(c.start, timezone)),
    })),
  };
}

function dayLabel(date: string, timezone: string): string {
  return formatDayLabel(DateTime.fromISO(date, { zone: timezone }));
}
