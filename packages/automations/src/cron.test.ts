import { describe, expect, it } from "vitest";
import { cronTicks, parseCron } from "./cron.ts";

const ZONE = "America/Bogota";
const utc = (iso: string) => new Date(iso);

describe("cronTicks", () => {
  it("fires at the local time, inside (from, to]", () => {
    // Mondays at 09:00 in Bogotá = 14:00 UTC. 2026-10-05 is a Monday.
    expect(
      cronTicks("0 9 * * 1", ZONE, utc("2026-10-05T12:00:00Z"), utc("2026-10-05T14:00:00Z")),
    ).toEqual([utc("2026-10-05T14:00:00Z")]);
    expect(
      cronTicks("0 9 * * 1", ZONE, utc("2026-10-05T14:00:00Z"), utc("2026-10-05T16:00:00Z")),
    ).toEqual([]);
    expect(
      cronTicks("0 9 * * 1", ZONE, utc("2026-10-06T12:00:00Z"), utc("2026-10-06T16:00:00Z")),
    ).toEqual([]);
  });

  it("supports steps, ranges and lists", () => {
    const ticks = cronTicks(
      "*/30 8-9 * * *",
      ZONE,
      utc("2026-10-05T12:59:00Z"),
      utc("2026-10-05T15:00:00Z"),
    );
    expect(ticks.map((t) => t.toISOString())).toEqual([
      "2026-10-05T13:00:00.000Z",
      "2026-10-05T13:30:00.000Z",
      "2026-10-05T14:00:00.000Z",
      "2026-10-05T14:30:00.000Z",
    ]);
  });

  it("treats 7 as Sunday and ORs restricted day fields", () => {
    expect(parseCron("0 9 * * 7")?.dayOfWeek.values.has(0)).toBe(true);
    // The 1st of the month OR Sundays: 2026-11-01 is a Sunday, 2026-11-08 too, 2026-12-01 a Tuesday.
    const spec = "0 9 1 * 0";
    expect(
      cronTicks(spec, ZONE, utc("2026-11-08T13:00:00Z"), utc("2026-11-08T15:00:00Z")),
    ).toHaveLength(1);
    expect(
      cronTicks(spec, ZONE, utc("2026-12-01T13:00:00Z"), utc("2026-12-01T15:00:00Z")),
    ).toHaveLength(1);
    expect(
      cronTicks(spec, ZONE, utc("2026-12-02T13:00:00Z"), utc("2026-12-02T15:00:00Z")),
    ).toHaveLength(0);
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["0 9 * *", "60 9 * * *", "0 9-8 * * *", "0 9 * * x"]) {
      expect(parseCron(bad)).toBeNull();
    }
  });
});
