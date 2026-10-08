import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  formatClock,
  formatCop,
  formatNowLong,
  formatRanges,
  formatSlotLabel,
  formatTime,
} from "./es-co.ts";

const BOGOTA = "America/Bogota";

describe("formatTime", () => {
  it.each([
    [0, 0, "12:00 a. m."],
    [8, 0, "8:00 a. m."],
    [9, 5, "9:05 a. m."],
    [12, 0, "12:00 m."],
    [12, 30, "12:30 p. m."],
    [15, 0, "3:00 p. m."],
    [23, 45, "11:45 p. m."],
  ])("%i:%i → %s", (hour, minute, expected) => {
    expect(formatTime(hour, minute)).toBe(expected);
  });

  it("uses plain ASCII spaces (no ICU no-break spaces)", () => {
    expect(formatTime(15, 0)).toMatch(/^[\x20-\x7e]+$/);
  });

  it("reads 24:00 as midnight", () => {
    expect(formatClock("24:00")).toBe("12:00 a. m.");
  });

  it("rejects malformed clock strings", () => {
    expect(() => formatClock("8:00")).toThrow(RangeError);
  });
});

describe("date labels", () => {
  const thursday3pm = DateTime.fromISO("2026-10-08T15:00:00", { zone: BOGOTA });

  it("formats a slot like the spec's example", () => {
    expect(formatSlotLabel(thursday3pm)).toBe("jueves 8 de octubre, 3:00 p. m.");
  });

  it("formats the current moment with the year", () => {
    const monday = DateTime.fromISO("2026-10-05T09:00:00-05:00").setZone(BOGOTA);
    expect(formatNowLong(monday)).toBe("lunes 5 de octubre de 2026, 9:00 a. m.");
  });

  it("uses the business timezone, not UTC", () => {
    const lateEvening = DateTime.fromISO("2026-10-09T02:30:00Z").setZone(BOGOTA);
    expect(formatSlotLabel(lateEvening)).toBe("jueves 8 de octubre, 9:30 p. m.");
  });
});

describe("buildCalendar", () => {
  const monday9am = DateTime.fromISO("2026-10-05T09:00:00-05:00").setZone(BOGOTA);

  it("resolves 'mañana' and 'el jueves' from a Monday", () => {
    const calendar = buildCalendar(monday9am);
    expect(calendar).toHaveLength(14);
    expect(calendar[0]).toEqual({
      date: "2026-10-05",
      label: "lunes 5 de octubre",
      relative: "hoy",
    });
    expect(calendar.find((d) => d.relative === "mañana")?.date).toBe("2026-10-06");
    expect(calendar.find((d) => d.label.startsWith("jueves"))?.date).toBe("2026-10-08");
  });

  it("crosses month boundaries", () => {
    const calendar = buildCalendar(DateTime.fromISO("2026-10-30T10:00:00", { zone: BOGOTA }), 4);
    expect(calendar.map((d) => d.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(calendar[2]).toMatchObject({
      label: "domingo 1 de noviembre",
      relative: "pasado mañana",
    });
  });

  it("starts at the business's local day even late at night UTC", () => {
    const calendar = buildCalendar(DateTime.fromISO("2026-10-06T03:00:00Z").setZone(BOGOTA), 1);
    expect(calendar[0]?.date).toBe("2026-10-05");
  });
});

describe("formatRanges", () => {
  it("joins a split day", () => {
    expect(
      formatRanges([
        { open: "08:00", close: "12:00" },
        { open: "13:00", close: "18:00" },
      ]),
    ).toBe("8:00 a. m. a 12:00 m. y 1:00 p. m. a 6:00 p. m.");
  });

  it("says closed for an empty day", () => {
    expect(formatRanges([])).toBe("cerrado");
  });
});

describe("formatCop", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [50000, "50.000"],
    [120000, "120.000"],
    [1250000, "1.250.000"],
    [-1000, "-1.000"],
    [999.6, "1.000"],
  ])("%d → %s", (amount, expected) => {
    expect(formatCop(amount)).toBe(expected);
  });
});
