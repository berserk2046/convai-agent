import type { DateTime } from "luxon";

/**
 * Spanish (Colombia) labels for dates, times and money. Built from explicit tables instead
 * of Intl: ICU output changes between Node versions (e.g. which space goes inside "p. m."),
 * and these strings end up in prompts, snapshots and eval assertions.
 */

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** Keys of a weekly schedule, Monday first (Luxon weekday 1..7). */
export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function weekdayName(weekday: number): string {
  const name = WEEKDAYS[weekday - 1];
  if (name === undefined) throw new RangeError(`weekday must be 1..7, got ${weekday}`);
  return name;
}

export function weekdayKeyName(key: WeekdayKey): string {
  return weekdayName(WEEKDAY_KEYS.indexOf(key) + 1);
}

function monthName(month: number): string {
  const name = MONTHS[month - 1];
  if (name === undefined) throw new RangeError(`month must be 1..12, got ${month}`);
  return name;
}

/** "3:00 p. m.", "9:05 a. m.", "12:00 m." (noon, as written in Colombia), "12:00 a. m.". */
export function formatTime(hour: number, minute: number): string {
  const mm = String(minute).padStart(2, "0");
  if (hour === 12 && minute === 0) return "12:00 m.";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${mm} ${hour < 12 || hour === 24 ? "a. m." : "p. m."}`;
}

/** Same as formatTime for an "HH:mm" string; "24:00" (end of day) reads as midnight. */
export function formatClock(hhmm: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new RangeError(`expected HH:mm, got "${hhmm}"`);
  return formatTime(Number(match[1]), Number(match[2]));
}

/** "jueves 8 de octubre" */
export function formatDayLabel(dt: DateTime): string {
  return `${weekdayName(dt.weekday)} ${dt.day} de ${monthName(dt.month)}`;
}

/** "jueves 8 de octubre, 3:00 p. m." — the label tools and messages use for a start time. */
export function formatSlotLabel(dt: DateTime): string {
  return `${formatDayLabel(dt)}, ${formatTime(dt.hour, dt.minute)}`;
}

/** "lunes 5 de octubre de 2026, 9:00 a. m." */
export function formatNowLong(dt: DateTime): string {
  return `${formatDayLabel(dt)} de ${dt.year}, ${formatTime(dt.hour, dt.minute)}`;
}

/** "8:00 a. m. a 12:00 m. y 1:00 p. m. a 6:00 p. m."; no ranges → "cerrado". */
export function formatRanges(ranges: readonly { open: string; close: string }[]): string {
  if (ranges.length === 0) return "cerrado";
  const parts = ranges.map((r) => `${formatClock(r.open)} a ${formatClock(r.close)}`);
  const last = parts.pop() as string;
  return parts.length === 0 ? last : `${parts.join(", ")} y ${last}`;
}

export interface CalendarDay {
  /** ISO date, e.g. "2026-10-08". */
  date: string;
  /** "jueves 8 de octubre" */
  label: string;
  /** "hoy", "mañana", "pasado mañana", or null. */
  relative: string | null;
}

const RELATIVE_DAYS = ["hoy", "mañana", "pasado mañana"];

/**
 * The next `days` days starting today in the DateTime's zone. Lets the agent look up
 * "el jueves" or "mañana" instead of doing date arithmetic itself.
 */
export function buildCalendar(now: DateTime, days = 14): CalendarDay[] {
  const start = now.startOf("day");
  return Array.from({ length: days }, (_, i) => {
    const day = start.plus({ days: i });
    return {
      date: day.toISODate() ?? "",
      label: formatDayLabel(day),
      relative: RELATIVE_DAYS[i] ?? null,
    };
  });
}

/** Colombian pesos without symbol: 120000 → "120.000". Decimals are rounded away. */
export function formatCop(amount: number): string {
  const rounded = Math.round(amount);
  const digits = String(Math.abs(rounded));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return rounded < 0 ? `-${grouped}` : grouped;
}
