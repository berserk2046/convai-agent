import { getPath, type Condition, type Context } from "@platform/templates";
import { DateTime } from "luxon";

/**
 * Conditions (spec §9), checked at send time. Field comparisons read the same context the
 * rule's texts render with: `booking.*` (the subject), `contact.*`, `business.*`.
 */

/** A value that counts as present for `exists`: not null, not empty text, not an empty list. */
function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** True when a field comparison holds; built-ins are checked elsewhere (they need the DB). */
export function fieldConditionHolds(condition: Condition, context: Context): boolean {
  if (condition.field === undefined) return true;
  const value = getPath(context, condition.field);
  if (condition.exists) return present(value);
  if (condition.not_exists) return !present(value);
  if (condition.in) return condition.in.some((v) => v === value);
  if (condition.eq !== undefined) return condition.eq === value;
  return true;
}

/** Spec §9: quiet hours are 20:00–08:00 local by default. */
export const QUIET_HOURS = { start: 20, end: 8 } as const;

/**
 * When a message due now should go out instead: null if `now` is outside quiet hours,
 * else the next 08:00 in the business timezone.
 */
export function quietHoursEnd(now: Date, timezone: string): Date | null {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (local.hour >= QUIET_HOURS.end && local.hour < QUIET_HOURS.start) return null;
  const morning = local.set({ hour: QUIET_HOURS.end, minute: 0, second: 0, millisecond: 0 });
  return (local.hour >= QUIET_HOURS.start ? morning.plus({ days: 1 }) : morning).toJSDate();
}
