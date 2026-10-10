import { formatTime } from "@platform/shared";

/** Display helpers. Business screens are Spanish (Colombia); dates show in the business timezone. */

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function parts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const map = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(map.weekday ?? "");
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

/** "jue 8 oct, 3:05 p. m." */
export function shortDateTime(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${WEEKDAYS[p.weekday] ?? ""} ${String(p.day)} ${MONTHS[p.month - 1] ?? ""}, ${formatTime(p.hour, p.minute)}`;
}

/** Today: "3:05 p. m."; otherwise "8 oct". */
export function when(at: Date, timeZone: string, now = new Date()): string {
  const p = parts(at, timeZone);
  const n = parts(now, timeZone);
  if (p.year === n.year && p.month === n.month && p.day === n.day)
    return formatTime(p.hour, p.minute);
  return `${String(p.day)} ${MONTHS[p.month - 1] ?? ""}`;
}

export function minuteLabel(minute: number): string {
  return formatTime(Math.floor(minute / 60), minute % 60);
}

/** USD with cents, the Colombian way: "1.234,50". */
export function usd(amount: number, digits = 2): string {
  return new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/** English for owner screens: "Oct 8, 3:05 PM" (UTC−5 business time when given). */
export function ownerDateTime(at: Date, timeZone = "America/Bogota"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
