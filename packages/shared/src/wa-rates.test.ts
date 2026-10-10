import { describe, expect, it } from "vitest";
import { waCharge } from "./wa-rates.ts";

const pricing = (
  type: string | null,
  category: string | null,
  billable: boolean | null = true,
) => ({
  billable,
  type,
  category,
});

describe("waCharge (Meta's Colombia rates, 2026-10-01)", () => {
  it.each([
    ["marketing", "wa_marketing", 0.0125],
    ["marketing_lite", "wa_marketing", 0.0125],
    ["utility", "wa_utility", 0.0008],
    ["authentication", "wa_auth", 0.0008],
    ["service", "wa_service", 0.0008],
  ])("%s → %s at %f USD", (category, kind, usd) => {
    expect(waCharge(pricing("regular", category), "573001234567")).toEqual({
      kind,
      usd,
      market: "CO",
      estimated: false,
    });
  });

  it("charges nothing for free deliveries", () => {
    expect(waCharge(pricing("free_customer_service", "service"), "573001234567")).toBeNull();
    expect(waCharge(pricing("free_entry_point", "marketing"), "573001234567")).toBeNull();
    expect(waCharge(pricing("regular", "referral_conversion"), "573001234567")).toBeNull();
  });

  it("falls back to the billable flag when Meta sends no type", () => {
    expect(waCharge(pricing(null, "utility", true), "573001234567")?.usd).toBe(0.0008);
    expect(waCharge(pricing(null, "utility", false), "573001234567")).toBeNull();
  });

  it("marks other markets as estimates", () => {
    expect(waCharge(pricing("regular", "marketing"), "16505551234")).toMatchObject({
      market: "unknown",
      estimated: true,
    });
  });
});
