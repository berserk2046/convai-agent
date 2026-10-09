import { DateTime } from "luxon";

/**
 * The `schedule` trigger's cron (minute hour day-of-month month day-of-week), evaluated in
 * the business timezone. Supports what the template validator accepts: numbers, ranges,
 * steps, lists and "*". As in classic cron, when both day fields are restricted, either
 * one matching is enough.
 */

interface Field {
  values: ReadonlySet<number>;
  any: boolean;
}

export interface CronSpec {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  /** 0 = Sunday (7 is accepted and means Sunday too). */
  dayOfWeek: Field;
}

const BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function parseCron(expression: string): CronSpec | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: Field[] = [];
  for (const [i, part] of parts.entries()) {
    const bounds = BOUNDS[i];
    const field = bounds ? parseField(part, bounds) : null;
    if (!field) return null;
    fields.push(field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    Field,
    Field,
    Field,
    Field,
    Field,
  ];
  const days = new Set([...dayOfWeek.values].map((d) => d % 7));
  return { minute, hour, dayOfMonth, month, dayOfWeek: { values: days, any: dayOfWeek.any } };
}

function parseField(text: string, [min, max]: [number, number]): Field | null {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) return null;
    const star = match[1] === "*";
    const from = star ? min : Number(match[2]);
    const to = star ? max : match[3] === undefined ? (match[4] ? max : from) : Number(match[3]);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: text === "*" };
}

export function cronMatches(spec: CronSpec, local: DateTime): boolean {
  if (!spec.minute.values.has(local.minute) || !spec.hour.values.has(local.hour)) return false;
  if (!spec.month.values.has(local.month)) return false;
  const dom = spec.dayOfMonth.values.has(local.day);
  const dow = spec.dayOfWeek.values.has(local.weekday % 7);
  if (spec.dayOfMonth.any && spec.dayOfWeek.any) return true;
  if (spec.dayOfMonth.any) return dow;
  if (spec.dayOfWeek.any) return dom;
  return dom || dow;
}

/** Every tick in (from, to], as instants. */
export function cronTicks(expression: string, timezone: string, from: Date, to: Date): Date[] {
  const spec = parseCron(expression);
  if (!spec) return [];
  const ticks: Date[] = [];
  let minute = DateTime.fromJSDate(from, { zone: timezone }).startOf("minute");
  if (minute.toMillis() <= from.getTime()) minute = minute.plus({ minutes: 1 });
  for (; minute.toMillis() <= to.getTime(); minute = minute.plus({ minutes: 1 })) {
    if (cronMatches(spec, minute)) ticks.push(minute.toJSDate());
  }
  return ticks;
}
