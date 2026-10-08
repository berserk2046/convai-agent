import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildBookingContext,
  buildBusinessContext,
  buildContactContext,
  resolveBookingRules,
} from "./context.ts";
import { compileObjectSchema } from "./json-schema/config-schema.ts";

const configSchema = (() => {
  const result = compileObjectSchema({
    type: "object",
    properties: {
      name: { type: "string" },
      maps_url: { $ref: "platform:url" },
      hours: { $ref: "platform:weekly_hours" },
      tags: { type: "array", items: { type: "string" } },
      policies: { type: "object", properties: { cancellation: { type: "string" } } },
      services: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, description: { type: "string" } },
        },
      },
      notice: { type: "integer", default: 2 },
    },
  });
  if (!result.compiled) throw new Error("schema");
  return result.compiled.schema;
})();

describe("buildBusinessContext", () => {
  const business = buildBusinessContext(
    {
      name: "Clínica",
      hours: { mon: [{ open: "08:00", close: "12:00" }], sat: [] },
      services: [{ key: "limpieza" }],
    },
    configSchema,
    "America/Bogota",
  );

  it("declares every optional field so strict Liquid can't crash on a blank one", () => {
    expect(business).toMatchObject({
      maps_url: null,
      tags: [],
      policies: { cancellation: null },
      services: [{ key: "limpieza", description: null }],
      timezone: "America/Bogota",
    });
  });

  it("adds a Spanish list for weekly hours", () => {
    const list = business.hours_list as { label: string; ranges: string }[];
    expect(list).toHaveLength(7);
    expect(list[0]).toEqual({
      key: "mon",
      label: "Lunes",
      ranges: "8:00 a. m. a 12:00 m.",
      closed: false,
    });
    expect(list[5]).toMatchObject({ label: "Sábado", ranges: "cerrado", closed: true });
  });
});

describe("resolveBookingRules", () => {
  it("reads _config references from the business config", () => {
    const rules = resolveBookingRules(
      { resource_kind: "chair", min_notice_hours_config: "notice", slots_to_offer: 3 },
      { notice: 6 },
    );
    expect(rules).toMatchObject({
      resource_kind: "chair",
      min_notice_hours: 6,
      slots_to_offer: 3,
      catalog_path: "services",
    });
    expect(rules).not.toHaveProperty("min_notice_hours_config");
  });
});

describe("booking and contact contexts", () => {
  const start = DateTime.fromISO("2026-10-08T15:00:00", { zone: "America/Bogota" });
  const booking = {
    id: "b1",
    service_key: "limpieza",
    service_name: "Limpieza dental",
    subject_name: "Laura Gómez",
    party_size: null,
    status: "confirmed",
    source: "agent",
    starts_at: start,
    ends_at: start.plus({ minutes: 45 }),
    resource_name: "Sillón 1",
    notes: null,
  };

  it("gives automations Spanish labels in the business timezone", () => {
    expect(buildBookingContext(booking)).toMatchObject({
      label: "jueves 8 de octubre, 3:00 p. m.",
      date_long: "jueves 8 de octubre",
      time: "3:00 p. m.",
      local_date: "2026-10-08",
      starts_at: "2026-10-08T15:00:00.000-05:00",
    });
  });

  it("fills declared contact fields with null and summarizes bookings", () => {
    const contact = buildContactContext(
      { name: null, fields: { is_minor: false }, upcomingBookings: [booking] },
      ["is_minor", "last_cleaning_date"],
    );
    expect(contact).toEqual({
      name: null,
      is_minor: false,
      last_cleaning_date: null,
      upcoming_bookings: [
        {
          id: "b1",
          service_key: "limpieza",
          service_name: "Limpieza dental",
          subject_name: "Laura Gómez",
          status: "confirmed",
          starts_at: "2026-10-08T15:00:00.000-05:00",
          label: "jueves 8 de octubre, 3:00 p. m.",
        },
      ],
    });
  });
});
