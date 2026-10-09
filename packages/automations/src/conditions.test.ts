import { describe, expect, it } from "vitest";
import { fieldConditionHolds, quietHoursEnd } from "./conditions.ts";

const context = {
  booking: { status: "pending", service_key: "limpieza" },
  contact: { name: null, last_cleaning_date: "2026-04-05" },
  business: { review_url: "https://g.page/r/x", maps_url: null, insurers: [] },
};

describe("field conditions", () => {
  it.each([
    [{ field: "booking.status", in: ["pending", "confirmed"] }, true],
    [{ field: "booking.status", eq: "confirmed" }, false],
    [{ field: "business.review_url", exists: true as const }, true],
    [{ field: "business.maps_url", exists: true as const }, false],
    [{ field: "business.insurers", not_exists: true as const }, true],
    [{ field: "contact.name", not_exists: true as const }, true],
  ])("%o → %s", (condition, expected) => {
    expect(fieldConditionHolds(condition, context)).toBe(expected);
  });
});

describe("quietHoursEnd", () => {
  const zone = "America/Bogota";
  it("lets daytime through", () => {
    expect(quietHoursEnd(new Date("2026-10-05T19:59:00-05:00"), zone)).toBeNull();
    expect(quietHoursEnd(new Date("2026-10-05T08:00:00-05:00"), zone)).toBeNull();
  });

  it("moves evenings to the next morning and early mornings to 08:00 the same day", () => {
    expect(quietHoursEnd(new Date("2026-10-05T21:00:00-05:00"), zone)).toEqual(
      new Date("2026-10-06T08:00:00-05:00"),
    );
    expect(quietHoursEnd(new Date("2026-10-06T06:30:00-05:00"), zone)).toEqual(
      new Date("2026-10-06T08:00:00-05:00"),
    );
  });
});
