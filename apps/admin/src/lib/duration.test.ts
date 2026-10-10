import { describe, expect, it } from "vitest";
import { joinDuration, splitDuration } from "./duration.ts";

describe("splitDuration / joinDuration", () => {
  it("reads the sign, amount and unit a template wrote", () => {
    expect(splitDuration("-24h")).toEqual({ negative: true, amount: 24, unit: "h" });
    expect(splitDuration("180d")).toEqual({ negative: false, amount: 180, unit: "d" });
    expect(splitDuration(" 30m ")).toEqual({ negative: false, amount: 30, unit: "m" });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "24", "1.5h", "-h", "2w", "10:00", "0 9 * * 1"]) {
      expect(splitDuration(bad)).toBeNull();
    }
  });

  it("round-trips, and never writes -0", () => {
    for (const value of ["-24h", "180d", "0m", "-90m"]) {
      const parts = splitDuration(value);
      expect(parts && joinDuration(parts)).toBe(value);
    }
    expect(joinDuration({ negative: true, amount: 0, unit: "h" })).toBe("0h");
  });
});
