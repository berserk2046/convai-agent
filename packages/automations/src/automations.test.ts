import {
  applyWaTemplateUpdate,
  automationRuns,
  bookings,
  completeDueBookings,
  contacts,
  ensureConversation,
  listStaffNotifications,
  openHandoff,
  optOutContact,
  withTenant,
} from "@platform/db";
import { completeBookings } from "@platform/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { updateAutomationSettings } from "./settings.ts";
import { sweepAutomations } from "./sweep.ts";

/**
 * Spec §15 M4 acceptance, with a mock clock (Bogotá, UTC−5): one reminder 24 h ahead;
 * rescheduling makes a new occurrence and the old one never fires; "Confirmo" confirms;
 * the review request 2 h after completion; the recall 180 days after last_cleaning_date;
 * opt-out blocks all of them.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

const runsOf = async (subjectId: string) =>
  h.core.testDb.db.select().from(automationRuns).where(eq(automationRuns.subjectId, subjectId));

const bookingStatus = async (id: string) =>
  (await h.core.testDb.db.select().from(bookings).where(eq(bookings.id, id)))[0]?.status;

const notifications = () =>
  withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
    listStaffNotifications(tx, h.core.business.id),
  );

describe("reminder 24 h ahead (recordatorio_24h)", () => {
  it("goes out exactly once, with the booking's details and button payloads", async () => {
    const laura = await h.patient("573100000001");
    const booking = await h.book(laura, "2026-11-12T15:00:00-05:00");

    await h.tick("2026-11-11T14:59:00-05:00");
    expect(h.templatesTo("573100000001")).toEqual([]);
    await h.tick("2026-11-11T15:00:00-05:00");
    await h.tick("2026-11-11T15:01:00-05:00");
    await h.tick("2026-11-11T16:30:00-05:00");

    expect(h.templatesTo("573100000001")).toEqual(["recordatorio_cita_v1"]);
    const request = h.core.graph.requests.find((r) => r.body.to === "573100000001");
    const runs = await runsOf(booking.id);
    expect(runs.map((r) => [r.status, r.occurrenceKey])).toEqual([
      ["sent", "2026-11-12T20:00:00.000Z"],
    ]);
    expect(request?.body.template).toEqual({
      name: "recordatorio_cita_v1",
      language: { code: "es" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Laura Gómez" },
            { type: "text", text: "Limpieza dental" },
            { type: "text", text: "Clínica Dental Demo" },
            { type: "text", text: "jueves 12 de noviembre" },
            { type: "text", text: "3:00 p. m." },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [
            { type: "payload", payload: `recordatorio_24h:${runs[0]?.id ?? ""}:confirm` },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [
            { type: "payload", payload: `recordatorio_24h:${runs[0]?.id ?? ""}:reschedule` },
          ],
        },
      ],
    });
  });

  it("is never sent when the booking was made after the reminder time (B29)", async () => {
    const pedro = await h.patient("573100000002", { name: "Pedro Ruiz" });
    const late = await h.book(pedro, "2026-11-12T16:00:00-05:00", {
      createdAt: "2026-11-12T06:00:00-05:00",
    });
    await h.tick("2026-11-11T16:00:00-05:00");
    await h.tick("2026-11-12T07:00:00-05:00");
    expect(h.templatesTo("573100000002")).toEqual([]);
    expect(await runsOf(late.id)).toEqual([]);
  });
});

describe("rescheduling", () => {
  it("creates a new occurrence; the old one never fires", async () => {
    const ana = await h.patient("573100000003", { name: "Ana Pérez" });
    const booking = await h.book(ana, "2026-11-13T09:00:00-05:00");
    await h.core.testDb.db
      .update(bookings)
      .set({
        startsAt: new Date("2026-11-16T09:00:00-05:00"),
        endsAt: new Date("2026-11-16T09:45:00-05:00"),
        rescheduledAt: new Date("2026-11-11T12:00:00-05:00"),
      })
      .where(eq(bookings.id, booking.id));

    await h.tick("2026-11-12T09:00:00-05:00");
    expect(h.templatesTo("573100000003")).toEqual([]);
    await h.tick("2026-11-15T09:00:00-05:00");
    expect(h.templatesTo("573100000003")).toEqual(["recordatorio_cita_v1"]);
    expect((await runsOf(booking.id)).map((r) => r.occurrenceKey)).toEqual([
      "2026-11-16T14:00:00.000Z",
    ]);
  });

  it("a run queued for the old time is skipped when it comes up (B29)", async () => {
    const marta = await h.patient("573100000004", { name: "Marta Díaz" });
    const booking = await h.book(marta, "2026-11-20T09:00:00-05:00");
    h.setClock("2026-11-19T09:00:00-05:00");
    // Swept (run inserted and queued) but not executed yet…
    await sweepAutomations({ ...h.deps, now: h.now });
    // …and the booking moves before the job runs.
    await h.core.testDb.db
      .update(bookings)
      .set({
        startsAt: new Date("2026-11-23T09:00:00-05:00"),
        endsAt: new Date("2026-11-23T09:45:00-05:00"),
        rescheduledAt: new Date("2026-11-19T09:00:30-05:00"),
      })
      .where(eq(bookings.id, booking.id));
    const outcomes = await h.drain();
    expect(outcomes).toContainEqual({ status: "skipped", reason: "stale_occurrence" });
    expect(h.templatesTo("573100000004")).toEqual([]);
  });
});

describe("button replies", () => {
  it('"Confirmo" confirms the booking and thanks the patient, without the AI', async () => {
    const laura = await h.patient("573100000005", { name: "Laura Gómez" });
    const booking = await h.book(laura, "2026-11-25T15:00:00-05:00");
    await h.tick("2026-11-24T15:00:00-05:00");
    const [run] = await runsOf(booking.id);

    h.setClock("2026-11-24T15:10:00-05:00");
    const { llmRequests } = await h.receive("573100000005", {
      button: { text: "Confirmo", payload: `recordatorio_24h:${run?.id ?? ""}:confirm` },
    });
    expect(llmRequests).toBe(0);
    expect(await bookingStatus(booking.id)).toBe("confirmed");
    expect(h.textsTo("573100000005")).toEqual([
      "¡Gracias por confirmar, Laura Gómez! Le esperamos.",
    ]);

    // sin_confirmar (−15 h) then finds nothing to report.
    await h.tick("2026-11-25T00:00:00-05:00");
    const unconfirmed = (await runsOf(booking.id)).find((r) => r.reason?.startsWith("condition"));
    expect(unconfirmed).toMatchObject({ status: "skipped", reason: "condition:booking.status" });
  });

  it("an unconfirmed booking tells the staff at −15 h (sin_confirmar)", async () => {
    const pedro = await h.patient("573100000006", { name: "Pedro Ruiz" });
    await h.book(pedro, "2026-11-26T10:00:00-05:00");
    await h.tick("2026-11-25T10:00:00-05:00");
    await h.tick("2026-11-25T19:00:00-05:00");
    expect((await notifications()).map((n) => n.text)).toContain(
      "Pedro Ruiz no ha confirmado su cita de Limpieza dental (jueves 26 de noviembre, 10:00 a. m.).",
    );
  });

  it('"Necesito cambiar" hands the conversation to the agent with a note', async () => {
    const sofia = await h.patient("573100000007", { name: "Sofía Rojas" });
    const booking = await h.book(sofia, "2026-11-27T09:00:00-05:00");
    await h.tick("2026-11-26T09:00:00-05:00");
    const [run] = await runsOf(booking.id);
    h.setClock("2026-11-26T09:30:00-05:00");
    const { llmRequests, system } = await h.receive(
      "573100000007",
      {
        button: {
          text: "Necesito cambiar",
          payload: `recordatorio_24h:${run?.id ?? ""}:reschedule`,
        },
      },
      [{ text: "Claro, ¿para qué día le gustaría moverla?" }],
    );
    expect(llmRequests).toBe(1);
    expect(system).toContain('The customer tapped \\"Necesito cambiar\\"');
    expect(system).toContain(`booking_id ${booking.id}`);
    expect(h.textsTo("573100000007")).toEqual(["Claro, ¿para qué día le gustaría moverla?"]);
    expect(await bookingStatus(booking.id)).toBe("pending");
  });

  it("during a handoff: data changes, the bot stays silent, staff hear about it (A12)", async () => {
    const tomas = await h.patient("573100000008", { name: "Tomás Gil" });
    const booking = await h.book(tomas, "2026-11-28T09:00:00-05:00");
    await h.tick("2026-11-27T09:00:00-05:00");
    const [run] = await runsOf(booking.id);
    await withTenant(h.core.testDb.db, h.core.business.id, async (tx) => {
      const conversation = await ensureConversation(tx, h.core.business.id, tomas.id);
      await openHandoff(tx, {
        businessId: h.core.business.id,
        conversationId: conversation.id,
        reason: "pide_humano",
        summary: null,
      });
    });
    h.setClock("2026-11-27T09:10:00-05:00");
    const { llmRequests } = await h.receive("573100000008", {
      button: { text: "Confirmo", payload: `recordatorio_24h:${run?.id ?? ""}:confirm` },
    });
    expect(llmRequests).toBe(0);
    expect(await bookingStatus(booking.id)).toBe("confirmed");
    expect(h.textsTo("573100000008")).toEqual([]);
    expect((await notifications()).map((n) => n.text)).toContain(
      "Tomás Gil tocó «Confirmo» en un mensaje automático mientras la conversación está con el equipo.",
    );
  });

  it("a tap on a reminder for a booking that moved since then isn't acted on", async () => {
    const ines = await h.patient("573100000009", { name: "Inés Mora" });
    const booking = await h.book(ines, "2026-11-30T09:00:00-05:00");
    await h.tick("2026-11-29T09:00:00-05:00");
    const [run] = await runsOf(booking.id);
    await h.core.testDb.db
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date("2026-11-29T09:05:00-05:00") })
      .where(eq(bookings.id, booking.id));
    h.setClock("2026-11-29T09:10:00-05:00");
    const { llmRequests, system } = await h.receive(
      "573100000009",
      { button: { text: "Confirmo", payload: `recordatorio_24h:${run?.id ?? ""}:confirm` } },
      [{ text: "Esa cita ya no está activa. ¿Quiere agendar una nueva?" }],
    );
    expect(await bookingStatus(booking.id)).toBe("cancelled");
    expect(llmRequests).toBe(1);
    expect(system).toContain("has since been moved or has ended");
  });
});

describe("after the visit", () => {
  it("records the cleaning date at completion and asks for a review 2 h later", async () => {
    const laura = await h.patient("573100000010", { name: "Laura Gómez" });
    const booking = await h.book(laura, "2026-12-01T10:00:00-05:00");
    await completeBookings({
      db: h.core.testDb.db,
      logger: h.core.deps.logger,
      events: h.deps.events,
      now: () => new Date("2026-12-01T11:50:00-05:00"),
    });
    expect(await bookingStatus(booking.id)).toBe("completed");

    await h.tick("2026-12-01T11:50:00-05:00");
    const [contact] = await h.core.testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, laura.id));
    expect(contact?.fields).toEqual({ last_cleaning_date: "2026-12-01" });

    await h.tick("2026-12-01T13:49:00-05:00");
    expect(h.templatesTo("573100000010")).toEqual([]);
    await h.tick("2026-12-01T13:50:00-05:00");
    expect(h.templatesTo("573100000010")).toEqual(["solicitud_resena_v1"]);
  });

  it("waits for 08:00 when the review would land in quiet hours", async () => {
    const ana = await h.patient("573100000011", { name: "Ana Pérez" });
    const booking = await h.book(ana, "2026-12-02T17:00:00-05:00");
    await completeDueBookings(h.core.testDb.db, new Date("2026-12-02T18:50:00-05:00"));
    const outcomes = await h.tick("2026-12-02T20:50:00-05:00");
    expect(outcomes).toContainEqual({
      status: "postponed",
      until: new Date("2026-12-03T08:00:00-05:00"),
    });
    expect(h.templatesTo("573100000011")).toEqual([]);
    await h.tick("2026-12-03T08:00:00-05:00");
    expect(h.templatesTo("573100000011")).toEqual(["solicitud_resena_v1"]);
    expect((await runsOf(booking.id)).map((r) => r.status)).toContain("sent");
  });
});

describe("recall 180 days after the last cleaning (control_6_meses)", () => {
  it("is off by default, and fires at 10:00 local once enabled", async () => {
    const pablo = await h.patient("573100000012", { name: "Pablo Mejía" });
    await h.core.testDb.db
      .update(contacts)
      .set({ fields: { last_cleaning_date: "2026-06-05" } })
      .where(eq(contacts.id, pablo.id));
    // 2026-06-05 + 180 days = 2026-12-02.
    await h.tick("2026-12-02T10:00:00-05:00");
    expect(h.templatesTo("573100000012")).toEqual([]);

    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      updateAutomationSettings(tx, h.core.business.id, "control_6_meses", { enabled: true }),
    );
    await h.tick("2026-12-02T10:01:00-05:00");
    expect(h.templatesTo("573100000012")).toEqual(["control_6_meses_v1"]);
    await h.tick("2026-12-02T11:00:00-05:00");
    expect(h.templatesTo("573100000012")).toEqual(["control_6_meses_v1"]);
  });

  it("is skipped while the patient already has a future booking, or has no name (A10)", async () => {
    const booked = await h.patient("573100000013", { name: "Juan Gil" });
    await h.book(booked, "2026-12-20T09:00:00-05:00");
    const nameless = await h.patient("573100000014", { name: null });
    for (const contact of [booked, nameless]) {
      await h.core.testDb.db
        .update(contacts)
        .set({ fields: { last_cleaning_date: "2026-06-06" } })
        .where(eq(contacts.id, contact.id));
    }
    await h.tick("2026-12-03T10:00:00-05:00");
    expect(h.templatesTo("573100000013")).toEqual([]);
    expect(h.templatesTo("573100000014")).toEqual([]);
    expect((await runsOf(booked.id)).map((r) => r.reason)).toEqual(["future_booking"]);
    expect((await runsOf(nameless.id)).map((r) => r.reason)).toEqual(["missing_variable"]);
  });
});

describe("opt-out", () => {
  it("blocks the reminder, the review request and the recall", async () => {
    const sara = await h.patient("573100000015", { name: "Sara León" });
    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      optOutContact(tx, sara.id, new Date("2026-12-01T00:00:00-05:00")),
    );
    await h.core.testDb.db
      .update(contacts)
      .set({ fields: { last_cleaning_date: "2026-06-07" } })
      .where(eq(contacts.id, sara.id));
    const upcoming = await h.book(sara, "2026-12-10T15:00:00-05:00");
    const past = await h.book(sara, "2026-12-04T09:00:00-05:00");
    await completeDueBookings(h.core.testDb.db, new Date("2026-12-04T10:50:00-05:00"));

    await h.tick("2026-12-04T10:00:00-05:00"); // recall day (06-07 + 180 days)
    await h.tick("2026-12-04T12:50:00-05:00"); // review time
    await h.tick("2026-12-09T15:00:00-05:00"); // reminder time

    expect(h.templatesTo("573100000015")).toEqual([]);
    const reasons = [
      ...(await runsOf(sara.id)),
      ...(await runsOf(upcoming.id)),
      ...(await runsOf(past.id)),
    ].map((r) => [r.status, r.reason]);
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect(
      reasons.every(([status, reason]) => status === "skipped" && reason === "opted_out"),
    ).toBe(true);
  });
});

describe("Meta template status", () => {
  it("only approved templates are sent", async () => {
    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      applyWaTemplateUpdate(
        tx,
        h.core.business.id,
        { name: "recordatorio_cita_v1", language: "es", metaTemplateId: "x" },
        { status: "PAUSED", at: new Date() },
      ),
    );
    const eva = await h.patient("573100000016", { name: "Eva Ruiz" });
    const booking = await h.book(eva, "2026-12-15T09:00:00-05:00");
    await h.tick("2026-12-14T09:00:00-05:00");
    expect(h.templatesTo("573100000016")).toEqual([]);
    expect((await runsOf(booking.id)).map((r) => r.reason)).toEqual(["template_not_approved"]);
    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      applyWaTemplateUpdate(
        tx,
        h.core.business.id,
        { name: "recordatorio_cita_v1", language: "es", metaTemplateId: "x" },
        { status: "APPROVED", at: new Date() },
      ),
    );
  });
});
