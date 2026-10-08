import { listActiveBookings, listActiveResources, listClosures, withTenant } from "@platform/db";
import {
  findCandidates,
  searchWindow,
  type Candidate,
  type TimeOfDay,
  type WeeklyHours,
} from "@platform/scheduling";
import { PLATFORM_TYPE_KEYWORD } from "@platform/templates";
import { DateTime } from "luxon";
import type { CatalogItem } from "./catalog.ts";
import type { ToolContext } from "./types.ts";

/** Booking rules after tool-level overrides, with the types the scheduler needs. */
export interface EffectiveRules {
  resourceKind: string;
  durationFrom: "service" | "fixed";
  fixedDurationMin: number | null;
  bufferMin: number;
  maxDaysAhead: number;
  minNoticeHours: number;
  slotsToOffer: number;
  requireConfirmation: boolean;
  collect: string[];
  catalogPath: string;
}

export function effectiveRules(ctx: ToolContext, params: Record<string, unknown>): EffectiveRules {
  const r = { ...(ctx.rules ?? {}), ...params } as Record<string, unknown>;
  return {
    resourceKind: String(r.resource_kind),
    durationFrom: r.duration_from === "fixed" ? "fixed" : "service",
    fixedDurationMin: typeof r.fixed_duration_min === "number" ? r.fixed_duration_min : null,
    bufferMin: Number(r.buffer_min ?? 0),
    maxDaysAhead: Number(r.max_days_ahead ?? 30),
    minNoticeHours: Number(r.min_notice_hours ?? 0),
    slotsToOffer: Number(r.slots_to_offer ?? 3),
    requireConfirmation: r.require_explicit_confirmation !== false,
    collect: Array.isArray(r.collect) ? (r.collect as string[]) : ["subject_name"],
    catalogPath: typeof r.catalog_path === "string" ? r.catalog_path : "services",
  };
}

export function durationOf(item: CatalogItem, rules: EffectiveRules): number | null {
  if (rules.durationFrom === "fixed") return rules.fixedDurationMin;
  return typeof item.duration_min === "number" ? item.duration_min : null;
}

/** The business's weekly hours: the first config field of type platform:weekly_hours. */
export function businessHours(ctx: ToolContext): WeeklyHours {
  const properties = ctx.prepared.config.schema.properties as
    Record<string, Record<string, unknown>> | undefined;
  const field = Object.entries(properties ?? {}).find(
    ([, s]) => s[PLATFORM_TYPE_KEYWORD] === "weekly_hours",
  )?.[0];
  const hours = field ? ctx.config[field] : undefined;
  return typeof hours === "object" && hours !== null ? hours : {};
}

export interface SlotSearch {
  item: CatalogItem;
  rules: EffectiveRules;
  durationMin: number;
  dateFrom: string;
  dateTo: string;
  timeOfDay?: TimeOfDay | undefined;
  partySize?: number | undefined;
  /** When moving a booking, it doesn't block its own new slot. */
  ignoreBookingId?: string | undefined;
}

/** Free start times for a service, using bookings, closures and calendar busy blocks. */
export async function searchSlots(ctx: ToolContext, search: SlotSearch): Promise<Candidate[]> {
  const window = searchWindow({
    timezone: ctx.timezone,
    now: ctx.now,
    dateFrom: search.dateFrom,
    dateTo: search.dateTo,
    maxDaysAhead: search.rules.maxDaysAhead,
  });
  if (!window.valid) return [];
  const from = window.from.toJSDate();
  const to = window.to.plus({ days: 1 }).toJSDate();

  const data = await withTenant(ctx.db, ctx.business.id, async (tx) => {
    const resources = (
      await listActiveResources(tx, ctx.business.id, search.rules.resourceKind)
    ).filter(
      (r) =>
        search.partySize === undefined || r.capacity === null || r.capacity >= search.partySize,
    );
    const ids = resources.map((r) => r.id);
    const bookings = (await listActiveBookings(tx, ctx.business.id, ids, from, to)).filter(
      (b) => b.id !== search.ignoreBookingId,
    );
    const closures = await listClosures(tx, ctx.business.id, from, to);
    return { resources, bookings, closures };
  });
  const providerBusy = await ctx.provider.getBusy(
    data.resources.map((r) => r.id),
    { from, to },
  );

  return findCandidates({
    timezone: ctx.timezone,
    now: ctx.now,
    dateFrom: search.dateFrom,
    dateTo: search.dateTo,
    durationMin: search.durationMin,
    bufferMin: search.rules.bufferMin,
    minNoticeHours: search.rules.minNoticeHours,
    maxDaysAhead: search.rules.maxDaysAhead,
    businessHours: businessHours(ctx),
    resources: data.resources.map((r) => ({
      id: r.id,
      schedule: (r.schedule as WeeklyHours | null) ?? null,
    })),
    bookings: data.bookings.map((b) => ({
      resourceId: b.resourceId,
      start: b.startsAt,
      end: b.endsAt,
    })),
    blocked: [
      ...data.closures.map((c) => ({ resourceId: c.resourceId, start: c.startsAt, end: c.endsAt })),
      ...providerBusy,
    ],
    timeOfDay: search.timeOfDay,
  });
}

/** Local "YYYY-MM-DD" of an instant in the business timezone. */
export function localDate(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate() ?? "";
}
