import { DateTime } from "luxon";

/**
 * Colombian public holidays (festivos), spec review C2. Sources:
 * - Ley 51 de 1983 ("Ley Emiliani"), art. 1: the list, and which days move to the next
 *   Monday when they don't fall on one.
 * - Ley 2347 de 2024: October 12 is the "Día de la Diversidad Étnica y Cultural".
 * - Ley 2578 de 2026 (in force since 2026-06-01), art. 6: July 9, Nuestra Señora del Rosario
 *   de Chiquinquirá, also moved under Ley 51.
 * A new law means a new row here (with `since`), plus a test with the published dates.
 * Businesses choose by holiday key (e.g. "san_jose"), so a choice holds every year.
 */

export interface PublicHoliday {
  /** Local date of the day off, after any move to Monday, e.g. "2026-10-12". */
  date: string;
  key: string;
  /** Spanish name, as customers read it. */
  name: string;
}

type Rule =
  | { key: string; name: string; month: number; day: number; moves: boolean; since?: number }
  | { key: string; name: string; easterOffset: number; moves: boolean };

const RULES: readonly Rule[] = [
  { key: "ano_nuevo", name: "Año Nuevo", month: 1, day: 1, moves: false },
  { key: "reyes_magos", name: "Reyes Magos", month: 1, day: 6, moves: true },
  { key: "san_jose", name: "San José", month: 3, day: 19, moves: true },
  { key: "jueves_santo", name: "Jueves Santo", easterOffset: -3, moves: false },
  { key: "viernes_santo", name: "Viernes Santo", easterOffset: -2, moves: false },
  { key: "dia_del_trabajo", name: "Día del Trabajo", month: 5, day: 1, moves: false },
  { key: "ascension", name: "Ascensión del Señor", easterOffset: 39, moves: true },
  { key: "corpus_christi", name: "Corpus Christi", easterOffset: 60, moves: true },
  { key: "sagrado_corazon", name: "Sagrado Corazón", easterOffset: 68, moves: true },
  { key: "san_pedro_y_san_pablo", name: "San Pedro y San Pablo", month: 6, day: 29, moves: true },
  {
    key: "virgen_de_chiquinquira",
    name: "Virgen de Chiquinquirá",
    month: 7,
    day: 9,
    moves: true,
    since: 2026,
  },
  { key: "independencia", name: "Día de la Independencia", month: 7, day: 20, moves: false },
  { key: "batalla_de_boyaca", name: "Batalla de Boyacá", month: 8, day: 7, moves: false },
  { key: "asuncion", name: "Asunción de la Virgen", month: 8, day: 15, moves: true },
  {
    key: "diversidad_etnica_y_cultural",
    name: "Día de la Diversidad Étnica y Cultural",
    month: 10,
    day: 12,
    moves: true,
  },
  { key: "todos_los_santos", name: "Todos los Santos", month: 11, day: 1, moves: true },
  {
    key: "independencia_de_cartagena",
    name: "Independencia de Cartagena",
    month: 11,
    day: 11,
    moves: true,
  },
  { key: "inmaculada_concepcion", name: "Inmaculada Concepción", month: 12, day: 8, moves: false },
  { key: "navidad", name: "Navidad", month: 12, day: 25, moves: false },
];

const byYear = new Map<number, readonly PublicHoliday[]>();

/** Every public holiday of a year, by date. Two can share a date (e.g. 2038-07-05). */
export function colombianHolidays(year: number): readonly PublicHoliday[] {
  const cached = byYear.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const list = RULES.filter((rule) => !("since" in rule) || (rule.since ?? 0) <= year)
    .map((rule) => {
      const base =
        "easterOffset" in rule
          ? easter.plus({ days: rule.easterOffset })
          : DateTime.utc(year, rule.month, rule.day);
      const date = rule.moves ? nextMonday(base) : base;
      return { date: date.toISODate() ?? "", key: rule.key, name: rule.name };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  byYear.set(year, list);
  return list;
}

/** Holidays from `from` to `to`, both inclusive local dates ("2026-10-05"). */
export function holidaysBetween(from: string, to: string): PublicHoliday[] {
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  if (!Number.isInteger(first) || !Number.isInteger(last)) return [];
  const out: PublicHoliday[] = [];
  for (let year = first; year <= last; year += 1) {
    out.push(...colombianHolidays(year).filter((h) => h.date >= from && h.date <= to));
  }
  return out;
}

/** Every holiday the law defines, in calendar order: what the admin lists to switch on and off. */
export const COLOMBIAN_HOLIDAYS: readonly { key: string; name: string }[] = RULES.map(
  ({ key, name }) => ({ key, name }),
);

export function isHolidayKey(key: string): boolean {
  return RULES.some((rule) => rule.key === key);
}

export interface HolidayDay {
  /** Shared dates read "A y B". */
  name: string;
  keys: string[];
  /** The business chose to open on this holiday (every one of them, if two share the day). */
  open: boolean;
}

/**
 * The holiday on a local date, or null on a normal day. `openKeys` are the holidays the
 * business opens on every year (spec review C2); every other holiday closes it. A day two
 * holidays share stays closed unless the business opens on both: the safe direction.
 */
export function holidayOn(date: string, openKeys: Iterable<string> = []): HolidayDay | null {
  const holidays = holidaysBetween(date, date);
  if (holidays.length === 0) return null;
  const open = new Set(openKeys);
  return {
    name: holidays.map((h) => h.name).join(" y "),
    keys: holidays.map((h) => h.key),
    open: holidays.every((h) => open.has(h.key)),
  };
}

/** The day itself if it's a Monday, else the following Monday (Ley 51 de 1983, art. 1). */
function nextMonday(day: DateTime): DateTime {
  return day.plus({ days: (8 - day.weekday) % 7 });
}

/** Gregorian Easter Sunday (anonymous Gregorian algorithm, a.k.a. Meeus/Jones/Butcher). */
export function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.utc(year, month, day);
}
