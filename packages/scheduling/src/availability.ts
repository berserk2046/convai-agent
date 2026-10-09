import { WEEKDAY_KEYS, type WeekdayKey } from "@platform/shared";
import { DateTime } from "luxon";

/**
 * Free-slot computation (spec §8). Pure: the caller loads hours, resources, bookings and
 * closures; this decides which start times work. All wall-clock logic happens in the
 * business timezone; inputs and outputs are absolute instants.
 */

export interface TimeRange {
  open: string;
  close: string;
}
export type WeeklyHours = Partial<Record<WeekdayKey, readonly TimeRange[]>>;

export interface Busy {
  /** null = applies to every resource (a business-wide closure). */
  resourceId: string | null;
  start: Date;
  end: Date;
}

export type TimeOfDay = "morning" | "afternoon" | "evening";

export interface AvailabilityInput {
  timezone: string;
  now: Date;
  /** Inclusive local dates, "2026-10-08". Clipped to [today, today + maxDaysAhead]. */
  dateFrom: string;
  dateTo: string;
  durationMin: number;
  bufferMin: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  businessHours: WeeklyHours;
  /** Eligible resources (right kind, enough capacity). */
  resources: readonly { id: string; schedule: WeeklyHours | null }[];
  /** Active bookings; each also blocks `bufferMin` after it ends. */
  bookings: readonly Busy[];
  /** Closures and calendar busy blocks; nothing is added to these. */
  blocked: readonly Busy[];
  /** Local dates ("2026-10-12") the whole business is closed: public holidays it doesn't open on. */
  closedDates?: readonly string[];
  timeOfDay?: TimeOfDay | undefined;
  gridMin?: number;
}

export interface Candidate {
  start: Date;
  /** Local "YYYY-MM-DD" and minutes since local midnight, for spreading and matching. */
  day: string;
  minute: number;
  freeResourceIds: string[];
}

const MAX_DAYS_SCANNED = 62;

/** Local-day window actually searched, after clipping to today and max_days_ahead. */
export function searchWindow(
  input: Pick<AvailabilityInput, "timezone" | "now" | "dateFrom" | "dateTo" | "maxDaysAhead">,
) {
  const today = DateTime.fromJSDate(input.now, { zone: input.timezone }).startOf("day");
  const last = today.plus({ days: input.maxDaysAhead });
  const from = DateTime.max(
    DateTime.fromISO(input.dateFrom, { zone: input.timezone }).startOf("day"),
    today,
  );
  const to = DateTime.min(
    DateTime.fromISO(input.dateTo, { zone: input.timezone }).startOf("day"),
    last,
  );
  return { from, to, valid: from.isValid && to.isValid && from <= to };
}

/** Every start time (on the grid) where at least one resource is free, oldest first. */
export function findCandidates(input: AvailabilityInput): Candidate[] {
  const grid = input.gridMin ?? 15;
  const window = searchWindow(input);
  if (!window.valid) return [];
  const earliest = input.now.getTime() + input.minNoticeHours * 3_600_000;
  const lengthMs = (input.durationMin + input.bufferMin) * 60_000;
  const bufferMs = input.bufferMin * 60_000;

  const closed = new Set(input.closedDates ?? []);
  const candidates: Candidate[] = [];
  let day = window.from;
  for (let i = 0; day <= window.to && i < MAX_DAYS_SCANNED; i += 1, day = day.plus({ days: 1 })) {
    const dayKey = day.toISODate() ?? "";
    if (closed.has(dayKey)) continue;
    const key = WEEKDAY_KEYS[day.weekday - 1] as WeekdayKey;
    const byStart = new Map<number, string[]>();
    for (const resource of input.resources) {
      const ranges = intersect(
        input.businessHours[key] ?? [],
        resource.schedule ? (resource.schedule[key] ?? []) : null,
      );
      for (const range of ranges) {
        for (
          let minute = alignUp(range.open, grid);
          minute + input.durationMin + input.bufferMin <= range.close;
          minute += grid
        ) {
          const start = day.plus({ minutes: minute });
          const startMs = start.toMillis();
          if (startMs < earliest || !matchesTimeOfDay(minute, input.timeOfDay)) continue;
          const endMs = startMs + lengthMs;
          const blocked =
            input.bookings.some(
              (b) =>
                b.resourceId === resource.id &&
                overlaps(startMs, endMs, b.start.getTime(), b.end.getTime() + bufferMs),
            ) ||
            input.blocked.some(
              (b) =>
                (b.resourceId === null || b.resourceId === resource.id) &&
                overlaps(startMs, endMs, b.start.getTime(), b.end.getTime()),
            );
          if (blocked) continue;
          const free = byStart.get(minute) ?? [];
          free.push(resource.id);
          byStart.set(minute, free);
        }
      }
    }
    for (const minute of [...byStart.keys()].sort((a, b) => a - b)) {
      candidates.push({
        start: day.plus({ minutes: minute }).toJSDate(),
        day: dayKey,
        minute,
        freeResourceIds: byStart.get(minute) ?? [],
      });
    }
  }
  return candidates;
}

/** Morning before 12:00, afternoon 12:00–18:00, evening from 18:00 (spec review B21). */
function matchesTimeOfDay(minute: number, timeOfDay: TimeOfDay | undefined): boolean {
  if (timeOfDay === "morning") return minute < 12 * 60;
  if (timeOfDay === "afternoon") return minute >= 12 * 60 && minute < 18 * 60;
  if (timeOfDay === "evening") return minute >= 18 * 60;
  return true;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface MinuteRange {
  open: number;
  close: number;
}

/** "08:30" → 510; "24:00" → 1440. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Business ranges intersected with a resource's own (null = no override). */
function intersect(
  business: readonly TimeRange[],
  resource: readonly TimeRange[] | null,
): MinuteRange[] {
  const a = business.map((r) => ({ open: toMinutes(r.open), close: toMinutes(r.close) }));
  if (resource === null) return a;
  const b = resource.map((r) => ({ open: toMinutes(r.open), close: toMinutes(r.close) }));
  const out: MinuteRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const open = Math.max(x.open, y.open);
      const close = Math.min(x.close, y.close);
      if (open < close) out.push({ open, close });
    }
  }
  return out.sort((p, q) => p.open - q.open);
}

function alignUp(minute: number, grid: number): number {
  return Math.ceil(minute / grid) * grid;
}
