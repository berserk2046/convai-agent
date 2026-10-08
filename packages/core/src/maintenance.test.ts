import { contacts, createResource, insertBooking, upsertContact } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BookingEvent } from "./agent/tools/types.ts";
import { completeBookings } from "./maintenance.ts";
import { createCoreHarness, type CoreHarness } from "./testing.ts";

let h: CoreHarness;

beforeAll(async () => {
  h = await createCoreHarness();
});

afterAll(async () => {
  await h.close();
});

describe("completeBookings (spec §8)", () => {
  it("completes bookings an hour after they end and emits booking.completed", async () => {
    const chair = await createResource(h.testDb.db, {
      businessId: h.business.id,
      kind: "chair",
      name: "Sillón 1",
    });
    const contact = await upsertContact(h.testDb.db, h.business.id, "573300000001");
    const booking = await insertBooking(h.testDb.db, {
      businessId: h.business.id,
      contactId: contact.id,
      resourceId: chair.id,
      serviceKey: "limpieza",
      serviceName: "Limpieza dental",
      priceCop: 120000,
      subjectName: "Laura Gómez",
      partySize: null,
      startsAt: new Date("2026-10-05T09:00:00-05:00"),
      endsAt: new Date("2026-10-05T09:45:00-05:00"),
      source: "agent",
      notes: null,
    });
    const events: BookingEvent[] = [];
    const run = (at: string) =>
      completeBookings({
        db: h.deps.db,
        logger: h.deps.logger,
        events: { emit: (e) => Promise.resolve(void events.push(e)) },
        now: () => new Date(at),
      });

    expect(await run("2026-10-05T10:30:00-05:00")).toBe(0); // 45 min after the end: not yet
    expect(await run("2026-10-05T10:50:00-05:00")).toBe(1);
    expect(events).toEqual([
      {
        type: "booking.completed",
        businessId: h.business.id,
        bookingId: booking.id,
        at: new Date("2026-10-05T10:50:00-05:00"),
      },
    ]);
    expect(await run("2026-10-05T11:00:00-05:00")).toBe(0); // once only
    expect(
      (await h.testDb.db.select().from(contacts).where(eq(contacts.id, contact.id))).length,
    ).toBe(1);
  });
});
