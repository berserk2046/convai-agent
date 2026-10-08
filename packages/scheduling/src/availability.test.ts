import { buildCalendar } from "@platform/shared";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  findCandidates,
  type AvailabilityInput,
  type Busy,
  type WeeklyHours,
} from "./availability.ts";
import { chooseSlots } from "./offer.ts";

const ZONE = "America/Bogota";
const weekday = [
  { open: "08:00", close: "12:00" },
  { open: "13:00", close: "18:00" },
];
/** Appendix A's sample hours. */
const HOURS: WeeklyHours = {
  mon: weekday,
  tue: weekday,
  wed: weekday,
  thu: weekday,
  fri: weekday,
  sat: [{ open: "08:00", close: "13:00" }],
  sun: [],
};

const local = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

/** Monday 2026-10-05 09:00 in Bogotá (the eval clock), a 45-minute cleaning, 10-minute buffer. */
function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: ZONE,
    now: local("2026-10-05T09:00"),
    dateFrom: "2026-10-08",
    dateTo: "2026-10-08",
    durationMin: 45,
    bufferMin: 10,
    minNoticeHours: 2,
    maxDaysAhead: 45,
    businessHours: HOURS,
    resources: [{ id: "chair-1", schedule: null }],
    bookings: [],
    blocked: [],
    ...overrides,
  };
}

const times = (i: AvailabilityInput) =>
  findCandidates(i).map(
    (c) =>
      `${c.day} ${String(Math.floor(c.minute / 60)).padStart(2, "0")}:${String(c.minute % 60).padStart(2, "0")}`,
  );

describe("findCandidates", () => {
  it("respects opening hours and the lunch break (start + duration + buffer must fit)", () => {
    const slots = times(input());
    expect(slots[0]).toBe("2026-10-08 08:00");
    expect(slots).toContain("2026-10-08 11:00"); // 11:00 + 55 min = 11:55
    expect(slots).not.toContain("2026-10-08 11:15"); // would run into lunch
    expect(slots).not.toContain("2026-10-08 12:00");
    expect(slots).toContain("2026-10-08 13:00");
    expect(slots.at(-1)).toBe("2026-10-08 17:00"); // 17:00 + 55 = 17:55
  });

  it("keeps the buffer around existing bookings", () => {
    const booking: Busy = {
      resourceId: "chair-1",
      start: local("2026-10-08T09:00"),
      end: local("2026-10-08T09:45"),
    };
    const slots = times(input({ bookings: [booking] }));
    expect(slots).toContain("2026-10-08 08:00"); // 08:00–08:55 ends before 09:00
    expect(slots).not.toContain("2026-10-08 08:15"); // would end 09:10
    expect(slots).not.toContain("2026-10-08 09:45"); // inside the 10-minute buffer
    expect(slots).toContain("2026-10-08 10:00");
  });

  it("offers a time while any resource is free", () => {
    const busy: Busy = {
      resourceId: "chair-1",
      start: local("2026-10-08T15:00"),
      end: local("2026-10-08T15:45"),
    };
    const two = input({
      resources: [
        { id: "chair-1", schedule: null },
        { id: "chair-2", schedule: null },
      ],
      bookings: [busy],
    });
    const at3 = findCandidates(two).find((c) => c.minute === 15 * 60);
    expect(at3?.freeResourceIds).toEqual(["chair-2"]);
  });

  it("skips business-wide closures (holidays) and per-resource ones", () => {
    const holiday: Busy = {
      resourceId: null,
      start: local("2026-10-08T00:00"),
      end: local("2026-10-09T00:00"),
    };
    expect(times(input({ blocked: [holiday] }))).toEqual([]);
    const repair: Busy = {
      resourceId: "chair-1",
      start: local("2026-10-08T13:00"),
      end: local("2026-10-08T18:00"),
    };
    expect(times(input({ blocked: [repair] })).every((t) => t < "2026-10-08 13:00")).toBe(true);
  });

  it("applies the minimum notice", () => {
    const today = times(input({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }));
    expect(today[0]).toBe("2026-10-05 11:00"); // now 09:00 + 2 h
  });

  it("never offers past dates or beyond max_days_ahead", () => {
    const slots = times(input({ dateFrom: "2026-10-01", dateTo: "2026-12-31", maxDaysAhead: 3 }));
    expect(slots[0]?.slice(0, 10)).toBe("2026-10-05");
    expect(slots.at(-1)?.slice(0, 10)).toBe("2026-10-08");
  });

  it("is closed on Sunday and shorter on Saturday", () => {
    expect(times(input({ dateFrom: "2026-10-11", dateTo: "2026-10-11" }))).toEqual([]);
    expect(times(input({ dateFrom: "2026-10-10", dateTo: "2026-10-10" })).at(-1)).toBe(
      "2026-10-10 12:00",
    );
  });

  it.each([
    ["morning", "2026-10-08 08:00", "2026-10-08 11:00"],
    ["afternoon", "2026-10-08 13:00", "2026-10-08 17:00"],
  ] as const)("filters by time of day: %s", (timeOfDay, first, last) => {
    const slots = times(input({ timeOfDay }));
    expect([slots[0], slots.at(-1)]).toEqual([first, last]);
  });

  it("narrows to a resource's own schedule", () => {
    const morningsOnly = {
      mon: [{ open: "08:00", close: "12:00" }],
      thu: [{ open: "07:00", close: "10:00" }],
    };
    const slots = times(input({ resources: [{ id: "chair-2", schedule: morningsOnly }] }));
    expect([slots[0], slots.at(-1)]).toEqual(["2026-10-08 08:00", "2026-10-08 09:00"]);
  });

  it("works in Bogotá time all year (no daylight saving)", () => {
    for (const day of ["2026-03-09", "2026-11-02", "2026-12-28"]) {
      const [first] = findCandidates(
        input({ now: local("2026-01-01T00:00"), dateFrom: day, dateTo: day, maxDaysAhead: 400 }),
      );
      expect(first?.start.toISOString()).toBe(`${day}T13:00:00.000Z`); // 08:00 -05:00
    }
  });
});

describe("chooseSlots", () => {
  it("spreads a single afternoon instead of offering consecutive slots", () => {
    const { slots } = chooseSlots(findCandidates(input({ timeOfDay: "afternoon" })), 3);
    expect(slots.map((s) => s.minute / 60)).toEqual([13, 15, 17]);
  });

  it("spreads a week over different days and times", () => {
    const { slots } = chooseSlots(
      findCandidates(input({ dateFrom: "2026-10-06", dateTo: "2026-10-12" })),
      3,
    );
    expect(new Set(slots.map((s) => s.day)).size).toBe(3);
    expect(new Set(slots.map((s) => s.minute)).size).toBeGreaterThan(1);
  });

  it("confirms an exact time that is free, plus the nearest alternatives (A7)", () => {
    const offer = chooseSlots(findCandidates(input()), 3, "15:00");
    expect(offer.exact).toEqual({ day: "2026-10-08", minute: 900, available: true });
    expect(offer.slots.map((s) => s.minute)).toEqual([885, 900, 915]);
  });

  it("says when an exact time is taken and offers the closest ones", () => {
    const busy: Busy = {
      resourceId: "chair-1",
      start: local("2026-10-08T14:45"),
      end: local("2026-10-08T15:30"),
    };
    const offer = chooseSlots(findCandidates(input({ bookings: [busy] })), 2, "15:00");
    expect(offer.exact).toMatchObject({ available: false });
    // Busy 14:45–15:30 plus the buffer: 15:45 (45 min away) and 16:00 beat 13:45 (75 min).
    expect(offer.slots.map((s) => s.minute / 60)).toEqual([15.75, 16]);
  });

  it("returns nothing when nothing is free", () => {
    expect(chooseSlots([], 3)).toEqual({ slots: [], exact: null });
  });
});

describe("relative dates in the agent's context ('mañana', 'el jueves')", () => {
  it("map to the right days from the eval clock", () => {
    const calendar = buildCalendar(DateTime.fromISO("2026-10-05T09:00:00-05:00").setZone(ZONE));
    const mañana = calendar.find((d) => d.relative === "mañana")?.date ?? "";
    const jueves = calendar.find((d) => d.label.startsWith("jueves"))?.date ?? "";
    expect([mañana, jueves]).toEqual(["2026-10-06", "2026-10-08"]);
    expect(times(input({ dateFrom: jueves, dateTo: jueves }))[0]).toBe("2026-10-08 08:00");
  });
});
