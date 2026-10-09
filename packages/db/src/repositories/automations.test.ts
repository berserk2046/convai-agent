import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookings,
  contacts,
  conversations,
  type BusinessRow,
  type ContactRow,
  type ConversationRow,
  type ResourceRow,
} from "../schema/index.ts";
import { withTenant } from "../tenant.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import {
  countTemplateMessagesSince,
  dueBookingChanges,
  dueBookingCompletions,
  dueBookingStarts,
  dueContactDates,
  dueInactiveConversations,
  finishRun,
  getWaTemplate,
  hasSentRun,
  insertRuns,
  listAutomations,
  listDueRuns,
  listStaffNotifications,
  listWaTemplates,
  notifyStaff,
  postponeRun,
  type NewRun,
} from "./automations.ts";
import { activateBusiness } from "./businesses.ts";
import { ensureConversation, upsertContact } from "./conversations.ts";
import { createTestBusiness } from "./fixtures.ts";
import { insertOutboundMessage } from "./messages.ts";
import { createResource, insertBooking } from "./scheduling.ts";

let testDb: TestDatabase;
let business: BusinessRow;
let other: BusinessRow;
let chair: ResourceRow;
let contact: ContactRow;
let conversation: ConversationRow;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  testDb = await createTestDatabase();
  business = await createTestBusiness(testDb.db, "Clínica A");
  other = await createTestBusiness(testDb.db, "Clínica B");
  chair = await createResource(testDb.db, { businessId: business.id, kind: "chair", name: "S1" });
  contact = await upsertContact(testDb.db, business.id, "573001112233");
  conversation = await ensureConversation(testDb.db, business.id, contact.id);
});

afterAll(async () => {
  await testDb.drop();
});

async function addBooking(startsAt: string, createdAt: string, status = "pending") {
  const row = await insertBooking(testDb.db, {
    businessId: business.id,
    contactId: contact.id,
    resourceId: chair.id,
    serviceKey: "limpieza",
    serviceName: "Limpieza dental",
    priceCop: 120000,
    subjectName: "Laura Gómez",
    partySize: null,
    startsAt: at(startsAt),
    endsAt: new Date(at(startsAt).getTime() + 45 * 60_000),
    source: "agent",
    notes: null,
  });
  await testDb.db
    .update(bookings)
    .set({ createdAt: at(createdAt), status: status as "pending" })
    .where(eq(bookings.id, row.id));
  return row;
}

describe("automations rows", () => {
  it("are seeded from the template when a business is created", async () => {
    const rows = await listAutomations(testDb.db, business.id);
    expect(rows.map((r) => [r.ruleKey, r.enabled])).toEqual([
      ["actualizar_ultima_limpieza", true],
      ["control_6_meses", false],
      ["recordatorio_24h", true],
      ["resena_post_cita", true],
      ["sin_confirmar", true],
    ]);
  });
});

describe("runs (principle 8)", () => {
  it("insert once per occurrence, finish once, and come back when due", async () => {
    const [automation] = await listAutomations(testDb.db, business.id);
    if (!automation) throw new Error("no automation");
    const run: NewRun = {
      businessId: business.id,
      automationId: automation.id,
      subjectType: "booking",
      subjectId: contact.id,
      occurrenceKey: "2026-10-08T20:00:00.000Z",
      dueAt: at("2026-10-07T20:00:00Z"),
    };
    const [first] = await insertRuns(testDb.db, [run]);
    expect(first?.status).toBe("scheduled");
    expect(await insertRuns(testDb.db, [run])).toEqual([]);

    expect((await listDueRuns(testDb.db, at("2026-10-07T19:59:00Z"))).map((r) => r.id)).toEqual([]);
    expect((await listDueRuns(testDb.db, at("2026-10-07T20:00:00Z"))).map((r) => r.id)).toEqual([
      first?.id,
    ]);
    await postponeRun(testDb.db, first?.id ?? "", at("2026-10-08T13:00:00Z"));
    expect(await listDueRuns(testDb.db, at("2026-10-07T21:00:00Z"))).toEqual([]);

    expect(await finishRun(testDb.db, first?.id ?? "", { status: "sent" })).toBe(true);
    expect(await finishRun(testDb.db, first?.id ?? "", { status: "failed" })).toBe(false);
    expect(
      await hasSentRun(testDb.db, {
        automationId: automation.id,
        subjectType: "booking",
        subjectId: contact.id,
        occurrenceKey: run.occurrenceKey,
      }),
    ).toBe(true);
  });
});

describe("due subjects", () => {
  it("booking.starts_in: due reminders of active bookings, never before the booking existed (B29)", async () => {
    const early = await addBooking("2026-11-10T15:00:00Z", "2026-11-01T10:00:00Z");
    const late = await addBooking("2026-11-10T17:00:00Z", "2026-11-10T00:00:00Z"); // made 17 h ahead
    await addBooking("2026-11-10T19:00:00Z", "2026-11-01T10:00:00Z", "cancelled");
    const due = await withTenant(testDb.db, business.id, (tx) =>
      dueBookingStarts(
        tx,
        business.id,
        -24 * 60,
        at("2026-11-09T13:00:00Z"),
        at("2026-11-09T20:00:00Z"),
      ),
    );
    expect(due.map((d) => d.id)).toEqual([early.id]);
    expect(due[0]?.fireAt).toEqual(at("2026-11-09T15:00:00Z"));
    expect(late.id).toBeDefined();
  });

  it("booking.completed and booking changes", async () => {
    const done = await addBooking("2026-11-12T15:00:00Z", "2026-11-01T10:00:00Z", "completed");
    await testDb.db
      .update(bookings)
      .set({ completedAt: at("2026-11-12T17:00:00Z"), cancelledAt: null })
      .where(eq(bookings.id, done.id));
    const completions = await withTenant(testDb.db, business.id, (tx) =>
      dueBookingCompletions(
        tx,
        business.id,
        120,
        at("2026-11-12T18:00:00Z"),
        at("2026-11-12T19:00:00Z"),
      ),
    );
    expect(completions).toEqual([{ id: done.id, fireAt: at("2026-11-12T19:00:00Z") }]);

    const created = await withTenant(testDb.db, business.id, (tx) =>
      dueBookingChanges(
        tx,
        business.id,
        "created",
        at("2026-11-01T09:00:00Z"),
        at("2026-11-01T11:00:00Z"),
      ),
    );
    expect(created.map((c) => c.id)).toContain(done.id);
  });

  it("contact.date_field: date + offset at the local time, in the business timezone", async () => {
    const patient = await upsertContact(testDb.db, business.id, "573009998877");
    await testDb.db
      .update(contacts)
      .set({ fields: { last_cleaning_date: "2026-04-05" } })
      .where(eq(contacts.id, patient.id));
    const broken = await upsertContact(testDb.db, business.id, "573009998878");
    await testDb.db
      .update(contacts)
      .set({ fields: { last_cleaning_date: "2026-02-30" } })
      .where(eq(contacts.id, broken.id));

    // 2026-04-05 + 180 days = 2026-10-02, 10:00 in Bogotá = 15:00 UTC.
    const due = await withTenant(testDb.db, business.id, (tx) =>
      dueContactDates(tx, {
        businessId: business.id,
        field: "last_cleaning_date",
        offsetMin: 180 * 1440,
        atLocalTime: "10:00",
        timezone: "America/Bogota",
        from: at("2026-10-02T14:00:00Z"),
        to: at("2026-10-02T16:00:00Z"),
      }),
    );
    expect(due).toEqual([
      { id: patient.id, date: "2026-04-05", fireAt: at("2026-10-02T15:00:00Z") },
    ]);
  });

  it("conversation.inactive", async () => {
    await testDb.db
      .update(conversations)
      .set({ lastInboundAt: at("2026-10-01T12:00:00Z") })
      .where(eq(conversations.id, conversation.id));
    const due = await withTenant(testDb.db, business.id, (tx) =>
      dueInactiveConversations(
        tx,
        business.id,
        60,
        at("2026-10-01T12:30:00Z"),
        at("2026-10-01T13:00:00Z"),
      ),
    );
    expect(due).toEqual([{ id: conversation.id, lastInboundAt: at("2026-10-01T12:00:00Z") }]);
  });
});

describe("Meta templates on activation", () => {
  it("records one row per wa_templates entry, named <key>_v<major>", async () => {
    const activated = await activateBusiness(testDb.db, business.id);
    expect(activated.status).toBe("active");
    const rows = await listWaTemplates(testDb.db, business.id);
    expect(rows.map((r) => [r.metaName, r.language, r.categoryRequested, r.metaStatus])).toEqual([
      ["control_6_meses_v1", "es", "MARKETING", null],
      ["recordatorio_cita_v1", "es", "UTILITY", null],
      ["solicitud_resena_v1", "es", "UTILITY", null],
    ]);
    const reminder = await getWaTemplate(testDb.db, business.id, "recordatorio_cita_v1", "es");
    expect(reminder?.components).toEqual([
      {
        type: "BODY",
        text: "Hola {{1}}, le recordamos su cita de {{2}} en {{3}} el {{4}} a las {{5}}. ¿Nos confirma su asistencia?",
        example: {
          body_text: [
            [
              "Laura",
              "Limpieza dental",
              "Clínica Dental Demo",
              "jueves 8 de octubre",
              "3:00 p. m.",
            ],
          ],
        },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Confirmo" },
          { type: "QUICK_REPLY", text: "Necesito cambiar" },
        ],
      },
    ]);
    // Activating again keeps Meta's state and adds nothing.
    await activateBusiness(testDb.db, business.id);
    expect(await listWaTemplates(testDb.db, business.id)).toHaveLength(3);
  });
});

describe("staff notifications and marketing counts", () => {
  it("dedupe by key and stay inside their tenant", async () => {
    const input = {
      businessId: business.id,
      kind: "usage" as const,
      text: "Uso de IA al 90 %",
      dedupeKey: "usage:llm:90:2026-10",
    };
    expect(await notifyStaff(testDb.db, input)).not.toBeNull();
    expect(await notifyStaff(testDb.db, input)).toBeNull();
    const mine = await withTenant(testDb.db, business.id, (tx) =>
      listStaffNotifications(tx, business.id),
    );
    expect(mine.map((n) => n.text)).toEqual(["Uso de IA al 90 %"]);
    const theirs = await withTenant(testDb.db, other.id, (tx) =>
      listStaffNotifications(tx, business.id),
    );
    expect(theirs).toEqual([]);
  });

  it("count template messages by category since the start of the month", async () => {
    for (const [i, category] of ["MARKETING", "MARKETING", "UTILITY"].entries()) {
      await insertOutboundMessage(testDb.db, {
        businessId: business.id,
        conversationId: conversation.id,
        type: "template",
        body: "…",
        payload: { category },
        idempotencyKey: `count-${i}`,
      });
    }
    const since = at("2026-01-01T05:00:00Z");
    expect(await countTemplateMessagesSince(testDb.db, business.id, "MARKETING", since)).toBe(2);
    expect(await countTemplateMessagesSince(testDb.db, other.id, "MARKETING", since)).toBe(0);
  });
});
