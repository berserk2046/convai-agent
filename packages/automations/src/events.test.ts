import { conversations, listStaffNotifications, withTenant } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, odontologiaWith, type Harness } from "./harness.ts";

/** Triggers odontologia doesn't use: booking events, schedule (cron), conversation.inactive. */

let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    templateSource: odontologiaWith(
      ["booking.created", "schedule", "conversation.inactive"],
      `
  - key: aviso_nueva_cita
    description: Avisa al equipo de cada cita nueva.
    default_enabled: true
    trigger: { type: booking.created }
    action: { type: notify_staff, text: "Nueva cita de {{ booking.subject_name }} ({{ booking.label }})" }
  - key: agenda_semanal
    description: Recuerda al equipo revisar la agenda los lunes.
    default_enabled: true
    trigger: { type: schedule, cron: "0 8 * * 1" }
    action: { type: notify_staff, text: "Revise la agenda de la semana." }
  - key: seguimiento
    description: Pregunta si necesita algo más tras dos horas sin respuesta.
    default_enabled: true
    trigger: { type: conversation.inactive, duration: "2h" }
    action: { type: send_text, text: "¿Le puedo ayudar en algo más?" }
`,
    ),
  });
});

afterAll(async () => {
  await h.close();
});

const notes = async () =>
  (
    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      listStaffNotifications(tx, h.core.business.id),
    )
  ).map((n) => n.text);

describe("booking.created", () => {
  it("fires as soon as the event is emitted", async () => {
    const laura = await h.patient("573300000001", { name: "Laura Gómez" });
    h.setClock("2026-11-02T10:00:00-05:00");
    const booking = await h.book(laura, "2026-11-12T15:00:00-05:00", {
      createdAt: "2026-11-02T10:00:00-05:00",
    });
    await h.deps.events.emit({
      type: "booking.created",
      businessId: h.core.business.id,
      bookingId: booking.id,
      at: h.now(),
    });
    await h.drain();
    expect(await notes()).toContain(
      "Nueva cita de Laura Gómez (jueves 12 de noviembre, 3:00 p. m.)",
    );
  });

  it("is caught by the sweeper when the event never ran", async () => {
    const pedro = await h.patient("573300000002", { name: "Pedro Ruiz" });
    await h.book(pedro, "2026-11-13T09:00:00-05:00", { createdAt: "2026-11-02T11:00:00-05:00" });
    await h.tick("2026-11-02T11:01:00-05:00");
    await h.tick("2026-11-02T11:02:00-05:00");
    expect((await notes()).filter((n) => n.startsWith("Nueva cita de Pedro Ruiz"))).toHaveLength(1);
  });
});

describe("schedule (cron, business time)", () => {
  it("fires once per tick", async () => {
    // 2026-11-09 is a Monday.
    await h.tick("2026-11-09T07:59:00-05:00");
    await h.tick("2026-11-09T08:00:00-05:00");
    await h.tick("2026-11-09T08:30:00-05:00");
    expect((await notes()).filter((n) => n === "Revise la agenda de la semana.")).toHaveLength(1);
  });
});

describe("conversation.inactive", () => {
  it("sends a free-form text inside the 24-hour window, once per silence", async () => {
    const ana = await h.patient("573300000003", { name: "Ana Pérez" });
    await h.core.testDb.db
      .update(conversations)
      .set({ lastInboundAt: new Date("2026-11-10T09:00:00-05:00") })
      .where(eq(conversations.contactId, ana.id));
    await h.tick("2026-11-10T10:59:00-05:00");
    expect(h.textsTo("573300000003")).toEqual([]);
    await h.tick("2026-11-10T11:00:00-05:00");
    await h.tick("2026-11-10T11:30:00-05:00");
    expect(h.textsTo("573300000003")).toEqual(["¿Le puedo ayudar en algo más?"]);
  });
});
