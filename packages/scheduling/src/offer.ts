import type { Candidate } from "./availability.ts";
import { toMinutes } from "./availability.ts";

/**
 * Choosing which free slots to offer (spec §8): a few options spread across days and times,
 * never three consecutive slots. With an exact time asked for (decision A7), that time
 * comes first if free, then the nearest alternatives.
 */

export interface Offer {
  slots: Candidate[];
  /** Present when a specific time was asked for. */
  exact: { day: string; minute: number; available: boolean } | null;
}

export function chooseSlots(
  candidates: readonly Candidate[],
  count: number,
  aroundTime?: string,
): Offer {
  if (aroundTime !== undefined) return chooseAround(candidates, count, toMinutes(aroundTime));
  return { slots: spread(candidates, count), exact: null };
}

/**
 * Greedy farthest-point choice within the first `count` days that have availability: the
 * earliest slot first, then each next slot as far as possible (in days and minutes) from
 * those already chosen. Deterministic: ties go to the earlier slot.
 */
function spread(candidates: readonly Candidate[], count: number): Candidate[] {
  if (count <= 0 || candidates.length === 0) return [];
  const days = [...new Set(candidates.map((c) => c.day))].slice(0, count);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const pool = candidates.filter((c) => dayIndex.has(c.day));
  const position = (c: Candidate) => (dayIndex.get(c.day) ?? 0) * 1440 + c.minute;

  const first = pool[0];
  if (!first) return [];
  const picks = [first];
  while (picks.length < count) {
    let best: Candidate | null = null;
    let bestDistance = 0;
    for (const c of pool) {
      if (picks.includes(c)) continue;
      const distance = Math.min(...picks.map((p) => Math.abs(position(c) - position(p))));
      if (distance > bestDistance) {
        best = c;
        bestDistance = distance;
      }
    }
    if (!best) break;
    picks.push(best);
  }
  return picks.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The asked time on the first day it's free, else the closest times (same day first). */
function chooseAround(candidates: readonly Candidate[], count: number, minute: number): Offer {
  if (candidates.length === 0) return { slots: [], exact: null };
  const firstDay = candidates[0]?.day ?? "";
  const exactMatch = candidates.find((c) => c.minute === minute);
  const anchorDay = exactMatch?.day ?? firstDay;
  const ranked = [...candidates].sort((a, b) => {
    const dayA = a.day === anchorDay ? 0 : 1;
    const dayB = b.day === anchorDay ? 0 : 1;
    return (
      dayA - dayB ||
      Math.abs(a.minute - minute) - Math.abs(b.minute - minute) ||
      a.start.getTime() - b.start.getTime()
    );
  });
  return {
    slots: ranked.slice(0, count).sort((a, b) => a.start.getTime() - b.start.getTime()),
    exact: { day: exactMatch?.day ?? firstDay, minute, available: exactMatch !== undefined },
  };
}
