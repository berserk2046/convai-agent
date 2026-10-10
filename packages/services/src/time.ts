import { formatDayLabel, formatSlotLabel } from "@platform/shared";
import { DateTime } from "luxon";

/** Local date-times as HTML inputs exchange them ("2026-10-08T15:00"), in the business timezone. */

export function parseLocal(value: string, zone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const dt = DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toJSDate() : null;
}

export function toLocalInput(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** "jueves 8 de octubre, 3:00 p. m." */
export function slotLabel(at: Date, zone: string): string {
  return formatSlotLabel(DateTime.fromJSDate(at, { zone }));
}

/** "jueves 8 de octubre" for a local "YYYY-MM-DD". */
export function dayLabel(date: string, zone: string): string {
  return formatDayLabel(DateTime.fromISO(date, { zone }));
}

export function localDate(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toISODate() ?? "";
}

/** Start and end (exclusive) of a local month "2026-10", as instants. */
export function monthRange(month: string, zone: string): { from: Date; to: Date } | null {
  const start = DateTime.fromISO(`${month}-01`, { zone });
  if (!/^\d{4}-\d{2}$/.test(month) || !start.isValid) return null;
  return { from: start.toJSDate(), to: start.plus({ months: 1 }).toJSDate() };
}

export function currentMonth(now: Date, zone: string): string {
  return DateTime.fromJSDate(now, { zone }).toFormat("yyyy-MM");
}
