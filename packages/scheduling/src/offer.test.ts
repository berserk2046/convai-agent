import { describe, expect, it } from "vitest";
import type { Candidate } from "./availability.ts";
import { timeOfDayAt } from "./availability.ts";
import { nearbyDays } from "./offer.ts";

function at(day: string, hhmm: string): Candidate {
  const [h, m] = hhmm.split(":").map(Number);
  const minute = (h ?? 0) * 60 + (m ?? 0);
  return { start: new Date(`${day}T${hhmm}:00-05:00`), day, minute, freeResourceIds: ["r1"] };
}

const days = (result: ReturnType<typeof nearbyDays>) => result.map((d) => d.day);

describe("nearbyDays (owner, 2026-10-11)", () => {
  const candidates = [
    at("2026-10-07", "09:00"),
    at("2026-10-09", "09:00"),
    at("2026-10-09", "10:30"),
    at("2026-10-09", "11:30"),
    at("2026-10-10", "08:00"),
    at("2026-10-13", "10:00"),
    at("2026-10-20", "09:00"),
  ];

  it("picks the closest days around the asked one, then lists them in date order", () => {
    const result = nearbyDays(candidates, {
      from: "2026-10-11",
      to: "2026-10-11",
      days: 3,
      perDay: 2,
    });
    expect(days(result)).toEqual(["2026-10-09", "2026-10-10", "2026-10-13"]);
  });

  it("measures distance from the edges of an asked range and skips the days inside it", () => {
    const result = nearbyDays(candidates, {
      from: "2026-10-09",
      to: "2026-10-13",
      days: 2,
      perDay: 1,
    });
    expect(days(result)).toEqual(["2026-10-07", "2026-10-20"]);
  });

  it("breaks ties between a day before and a day after in favor of the earlier one", () => {
    const tie = [at("2026-10-10", "09:00"), at("2026-10-12", "09:00")];
    expect(
      days(nearbyDays(tie, { from: "2026-10-11", to: "2026-10-11", days: 1, perDay: 1 })),
    ).toEqual(["2026-10-10"]);
  });

  it("offers the times nearest an asked time, or spreads them through the day", () => {
    const options = { from: "2026-10-10", to: "2026-10-10", days: 1, perDay: 2 };
    const near = nearbyDays(candidates, { ...options, aroundTime: "11:00" })[0]?.slots;
    expect(near?.map((c) => c.minute)).toEqual([10 * 60 + 30, 11 * 60 + 30]);
    const spread = nearbyDays(candidates, options)[0]?.slots;
    expect(spread?.map((c) => c.minute)).toEqual([9 * 60, 11 * 60 + 30]);
  });

  it("returns nothing when no day has free times", () => {
    expect(nearbyDays([], { from: "2026-10-11", to: "2026-10-11", days: 3, perDay: 2 })).toEqual(
      [],
    );
  });

  it("names the part of the day of a time (spec review B21)", () => {
    expect([timeOfDayAt(11 * 60 + 59), timeOfDayAt(12 * 60), timeOfDayAt(18 * 60)]).toEqual([
      "morning",
      "afternoon",
      "evening",
    ]);
  });
});
