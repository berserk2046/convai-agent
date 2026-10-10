import {
  bookings,
  closures,
  contacts,
  createClosure,
  createResource,
  ensureConversation,
  handoffs,
  insertBooking,
  messages,
  notifyStaff,
  openHandoff,
  resources,
  staffNotifications,
  upsertContact,
  withTenant,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "./actor.ts";
import { createHarness, type Harness } from "./harness.ts";
import * as bookingsService from "./business/bookings.ts";
import * as inbox from "./business/inbox.ts";
import * as reports from "./business/reports.ts";
import * as setup from "./business/setup.ts";
import { NotFoundError } from "./errors.ts";

/**
 * Spec §13: every business service, called by business A's admin with business B's ids.
 * Each must fail as "not found" (never revealing that B's rows exist) and leave B's data
 * exactly as it was. Row-level security backs this up underneath (ADR 0005).
 */

let h: Harness;
let attacker: Actor;
const b = {
  resource: "",
  closure: "",
  contact: "",
  conversation: "",
  booking: "",
  notification: "",
};

beforeAll(async () => {
  h = await createHarness();
  attacker = await h.actor("admin@a.co", { business: h.a, role: "business_admin" });
  const db = h.deps.db;
  b.resource = (
    await createResource(db, { businessId: h.b.id, kind: "chair", name: "Sillón B" })
  ).id;
  b.closure = (
    await createClosure(db, {
      businessId: h.b.id,
      resourceId: null,
      startsAt: new Date("2030-01-01T13:00:00Z"),
      endsAt: new Date("2030-01-02T13:00:00Z"),
      reason: "B",
    })
  ).id;
  const contact = await upsertContact(db, h.b.id, "573900000001");
  b.contact = contact.id;
  b.conversation = (await ensureConversation(db, h.b.id, contact.id)).id;
  await withTenant(db, h.b.id, (tx) =>
    openHandoff(tx, {
      businessId: h.b.id,
      conversationId: b.conversation,
      reason: "pide_humano",
      summary: "B",
    }),
  );
  b.booking = (
    await insertBooking(db, {
      businessId: h.b.id,
      contactId: contact.id,
      resourceId: b.resource,
      serviceKey: "limpieza",
      serviceName: "Limpieza dental",
      priceCop: 1,
      subjectName: "Paciente B",
      partySize: null,
      startsAt: new Date("2020-01-10T15:00:00Z"),
      endsAt: new Date("2020-01-10T15:45:00Z"),
      source: "agent",
      notes: null,
    })
  ).id;
  b.notification =
    (await notifyStaff(db, { businessId: h.b.id, kind: "automation", text: "B" }))?.id ?? "";
});

afterAll(async () => {
  await h.close();
});

async function snapshotOfB() {
  const db = h.deps.db;
  return {
    resources: await db.select().from(resources).where(eq(resources.businessId, h.b.id)),
    closures: await db.select().from(closures).where(eq(closures.businessId, h.b.id)),
    contacts: await db.select().from(contacts).where(eq(contacts.businessId, h.b.id)),
    bookings: await db.select().from(bookings).where(eq(bookings.businessId, h.b.id)),
    handoffs: await db.select().from(handoffs).where(eq(handoffs.businessId, h.b.id)),
    messages: await db.select().from(messages).where(eq(messages.businessId, h.b.id)),
    notifications: await db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.businessId, h.b.id)),
  };
}

describe("cross-tenant attempts by business A's admin on business B's ids", () => {
  const attempts: [string, () => Promise<unknown>][] = [
    ["setup.editResource", () => setup.editResource(h.deps, attacker, b.resource, { name: "x" })],
    ["setup.removeClosure", () => setup.removeClosure(h.deps, attacker, b.closure)],
    [
      "setup.addClosure on B's resource",
      () =>
        setup.addClosure(h.deps, attacker, {
          resourceId: b.resource,
          from: "2030-02-01T08:00",
          to: "2030-02-01T09:00",
          reason: null,
        }),
    ],
    [
      "inbox.getConversationView",
      () => inbox.getConversationView(h.deps, attacker, b.conversation),
    ],
    [
      "inbox.replyToConversation",
      () =>
        inbox.replyToConversation(h.deps, attacker, b.conversation, {
          text: "x",
          clientId: "cross-0001",
        }),
    ],
    [
      "inbox.sendTemplateToConversation",
      () =>
        inbox.sendTemplateToConversation(h.deps, attacker, b.conversation, {
          templateKey: "control_6_meses",
          bookingId: null,
          clientId: "cross-0002",
        }),
    ],
    [
      "inbox.takeOverConversation",
      () => inbox.takeOverConversation(h.deps, attacker, b.conversation),
    ],
    ["inbox.closeHandoff", () => inbox.closeHandoff(h.deps, attacker, b.conversation)],
    [
      "inbox.reenableAutomaticMessages",
      () => inbox.reenableAutomaticMessages(h.deps, attacker, b.contact),
    ],
    [
      "inbox.recordConsent",
      () => inbox.recordConsent(h.deps, attacker, b.contact, { confirmed: true }),
    ],
    [
      "bookings.moveStaffBooking",
      () =>
        bookingsService.moveStaffBooking(h.deps, attacker, b.booking, {
          startsAt: "2030-01-01T10:00",
        }),
    ],
    [
      "bookings.cancelStaffBooking",
      () => bookingsService.cancelStaffBooking(h.deps, attacker, b.booking),
    ],
    [
      "bookings.confirmStaffBooking",
      () => bookingsService.confirmStaffBooking(h.deps, attacker, b.booking),
    ],
    ["bookings.markNoShow", () => bookingsService.markNoShow(h.deps, attacker, b.booking)],
    [
      "bookings.createStaffBooking with B's contact",
      () =>
        bookingsService.createStaffBooking(h.deps, attacker, {
          contactId: b.contact,
          serviceKey: "limpieza",
          startsAt: "2030-01-03T10:00",
        }),
    ],
    [
      "bookings.createStaffBooking on B's resource",
      () =>
        bookingsService.createStaffBooking(h.deps, attacker, {
          newContact: { waNumber: "300 111 2222", name: "Nuevo", consent: true },
          serviceKey: "limpieza",
          startsAt: "2030-01-03T10:00",
          resourceId: b.resource,
        }),
    ],
  ];

  it.each(attempts)("%s → not found", async (_name, attempt) => {
    await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reads of A's own screens never include B's rows", async () => {
    expect((await inbox.listInbox(h.deps, attacker)).map((i) => i.conversationId)).not.toContain(
      b.conversation,
    );
    expect((await inbox.listNotifications(h.deps, attacker)).map((n) => n.id)).not.toContain(
      b.notification,
    );
    const week = await bookingsService.bookingsView(h.deps, attacker, {
      date: "2020-01-10",
      view: "week",
    });
    expect(week.bookings).toEqual([]);
    expect(week.closures).toEqual([]);
    expect(await bookingsService.findContacts(h.deps, attacker, "5739")).toEqual([]);
    expect((await setup.getSetup(h.deps, attacker)).resources).toEqual([]);
    expect((await reports.monthlyReport(h.deps, attacker, "2020-01")).appointments.total).toBe(0);
  });

  it("marking B's notification read does nothing to it", async () => {
    await inbox.markRead(h.deps, attacker, [b.notification]);
    const [row] = await h.deps.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.id, b.notification));
    expect(row?.readAt).toBeNull();
  });

  it("left business B's data untouched", async () => {
    const before = await snapshotOfB();
    for (const [, attempt] of attempts) await attempt().catch(() => undefined);
    expect(await snapshotOfB()).toEqual(before);
    expect(before.handoffs[0]?.resolvedAt).toBeNull();
    expect(before.bookings[0]?.status).toBe("pending");
  });
});

describe("malformed ids (a bound action argument edited in the browser)", () => {
  const junk = "1' or '1'='1";
  const attempts: [string, () => Promise<unknown>][] = [
    ["setup.editResource", () => setup.editResource(h.deps, attacker, junk, { name: "x" })],
    ["setup.removeClosure", () => setup.removeClosure(h.deps, attacker, junk)],
    ["inbox.getConversationView", () => inbox.getConversationView(h.deps, attacker, junk)],
    ["inbox.closeHandoff", () => inbox.closeHandoff(h.deps, attacker, "not-a-uuid")],
    ["inbox.markRead", () => inbox.markRead(h.deps, attacker, [junk])],
    ["bookings.cancelStaffBooking", () => bookingsService.cancelStaffBooking(h.deps, attacker, "")],
    [
      "bookings.moveStaffBooking to a malformed resource",
      () =>
        bookingsService.moveStaffBooking(h.deps, attacker, b.booking, {
          startsAt: "2030-01-01T10:00",
          resourceId: junk,
        }),
    ],
  ];

  it.each(attempts)("%s → not found, not a database error", async (_name, attempt) => {
    await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
  });
});
