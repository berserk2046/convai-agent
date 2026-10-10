import { describe, expect, it } from "vitest";
import { normalizeWaNumber } from "./phone.ts";

describe("normalizeWaNumber", () => {
  it.each([
    ["300 123 4567", "573001234567"],
    ["+57 300-123-4567", "573001234567"],
    ["573001234567", "573001234567"],
    ["604 444 5566", "576044445566"],
    ["+1 650 555 1234", "16505551234"],
    ["12345", null],
    ["16505551234", null], // a foreign number needs the "+"
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeWaNumber(input)).toBe(expected);
  });
});
