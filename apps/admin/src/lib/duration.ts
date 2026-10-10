/**
 * Trigger durations as templates write them ("-24h", "180d", "30m") ↔ the number and unit
 * the /automations form shows. The sign says before (−) or after; the form keeps the
 * template's sign, so an admin changes how long, not which side of the event.
 */

export type DurationUnit = "m" | "h" | "d";

export interface DurationParts {
  negative: boolean;
  amount: number;
  unit: DurationUnit;
}

export function splitDuration(value: string): DurationParts | null {
  const match = /^(-?)(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) return null;
  return { negative: match[1] === "-", amount: Number(match[2]), unit: match[3] as DurationUnit };
}

export function joinDuration(parts: DurationParts): string {
  return `${parts.negative && parts.amount !== 0 ? "-" : ""}${String(parts.amount)}${parts.unit}`;
}

export const DURATION_UNITS: { unit: DurationUnit; label: string }[] = [
  { unit: "m", label: "minutos" },
  { unit: "h", label: "horas" },
  { unit: "d", label: "días" },
];
