import { describe, expect, it } from "vitest";
import { serviceWindow } from "./window.ts";

describe("serviceWindow", () => {
  const lastInbound = new Date("2026-10-05T14:00:00Z");

  it("is open for 24 hours after the person's last message", () => {
    expect(serviceWindow(lastInbound, new Date("2026-10-06T13:59:59Z"))).toEqual({
      open: true,
      closesAt: new Date("2026-10-06T14:00:00Z"),
    });
  });

  it("closes exactly at 24 hours", () => {
    expect(serviceWindow(lastInbound, new Date("2026-10-06T14:00:00Z")).open).toBe(false);
  });

  it("is closed if the person never wrote", () => {
    expect(serviceWindow(null, new Date())).toEqual({ open: false, closesAt: null });
  });
});
