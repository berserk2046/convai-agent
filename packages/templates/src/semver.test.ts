import { describe, expect, it } from "vitest";
import { compareSemver, isSemver, parseSemver } from "./semver.ts";

describe("semver", () => {
  it.each(["1.0.0", "0.1.0", "10.20.30", "1.0.0-rc.1", "1.0.0+build.5"])("accepts %s", (v) => {
    expect(isSemver(v)).toBe(true);
  });

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0.0", ""])("rejects %s", (v) => {
    expect(isSemver(v)).toBe(false);
  });

  it("parses parts", () => {
    expect(parseSemver("2.3.4-beta")).toEqual({ major: 2, minor: 3, patch: 4, prerelease: "beta" });
  });

  it.each([
    ["1.0.0", "1.0.1", -1],
    ["1.10.0", "1.9.0", 1],
    ["2.0.0", "2.0.0", 0],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-alpha", "1.0.0-beta", -1],
  ])("compare(%s, %s) has sign %i", (a, b, sign) => {
    expect(Math.sign(compareSemver(a, b))).toBe(sign);
  });
});
