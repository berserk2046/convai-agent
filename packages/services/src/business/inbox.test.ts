import {
  activateBusiness,
  applyWaTemplateUpdate,
  auditLog,
  contacts,
  createResource,
  getConversation,
  insertBooking,
  listWaTemplates,
  messages,
  notifyStaff,
  openHandoff,
  withTenant,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ActionRefusedError, NotFoundError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
  closeHandoff,
  getConversationView,
  listInbox,
  listNotifications,
  markRead,
  recordConsent,
  reenableAutomaticMessages,
  replyToConversation,
  sendTemplateToConversation,
  takeOverConversation,
  unreadNotificationCount,
} from "./inbox.ts";

let h: Harness;
let staff: Actor;

beforeAll(async () => {
  h = await createHarness();
  staff = await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
  await activateBusiness(h.deps.db, h.a.id);
  for (const row of await listWaTemplates(h.deps.db, h.a.id)) {
    await withTenant(h.deps.db, h.a.id, (tx) =>
      applyWaTemplateUpdate(
        tx,
        h.a.id,
        { name: row.metaName, language: row.language, metaTemplateId: `id-${row.metaName}` },
        { status: "APPROVED", at: new Date() },
      ),
    );
  }
});

afterAll(async () => {
  await h.close();
});

const sentTo = (to: string) => h.core.graph.requests.filter((r) => r.body.to === to);

describe("the inbox list", () => {
  it("puts open handoffs first, then the most recent conversations", async () => {
    const quiet = await h.receive("573400000001", "Hola, ¿tienen parqueadero?");
    const urgent = await h.receive("573400000002", "Necesito hablar con alguien");
    await h.receive("573400000003", "Gracias");
    await withTenant(h.deps.db, h.a.id, (tx) =>
      openHandoff(tx, {
        businessId: h.a.id,
        conversationId: urgent,
        reason: "pide_humano",
        summary: "Quiere una persona",
      }),
    );
    const items = await listInbox(h.deps, staff);
    expect(items[0]).toMatchObject({
      conversationId: urgent,
      mode: "human",
      // The template names its reasons for staff (agent.tools.handoff.labels).
      handoff: {
        reason: "pide_humano",
        label: "Pide hablar con una persona",
        summary: "Quiere una persona",
      },
      last: { direction: "inbound", preview: "Necesito hablar con alguien" },
    });
    expect(items.map((i) => i.title)).toEqual(["+573400000002", "+573400000003", "+573400000001"]);
    expect(
      (await listInbox(h.deps, staff, { onlyHandoffs: true })).map((i) => i.conversationId),
    ).toEqual([urgent]);
    expect(quiet).toBeDefined();
  });
});

describe("a conversation", () => {
  it("shows the thread, the contact, the 24-hour window and templates staff can send", async () => {
    const id = await h.receive("573400000010", "Hola, quiero una cita");
    const view = await getConversationView(h.deps, staff, id);
    expect(view).toMatchObject({
      mode: "bot",
      handoff: null,
      window: { open: true },
      contact: { waNumber: "573400000010", consent: null, optedOutAt: null },
      messages: [{ direction: "inbound", author: "customer", body: "Hola, quiero una cita" }],
    });
    expect(view.contact.fields.map((f) => f.title)).toEqual([
      "Última limpieza",
      "Es menor de edad",
      "Acudiente",
    ]);
    expect(view.templates.map((t) => [t.name, t.needsBooking])).toEqual([
      ["recordatorio_cita_v1", true],
      ["solicitud_resena_v1", true],
      ["control_6_meses_v1", false],
    ]);
  });

  it("a staff reply goes out, takes the conversation over, and isn't sent twice", async () => {
    const id = await h.receive("573400000011", "¿Me pueden llamar?");
    const input = { text: "Claro, ya le llamamos.", clientId: "form-0000001" };
    await replyToConversation(h.deps, staff, id, input);
    await replyToConversation(h.deps, staff, id, input);
    expect(sentTo("573400000011").map((r) => (r.body.text as { body: string }).body)).toEqual([
      "Claro, ya le llamamos.",
    ]);
    const view = await getConversationView(h.deps, staff, id);
    expect(view.mode).toBe("human");
    expect(view.handoff?.reason).toBe("staff");
    expect(view.messages.at(-1)).toMatchObject({
      author: "staff",
      staffName: "staff",
      status: "sent",
    });
    const actions = (await h.deps.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["handoff.open", "inbox.reply"]));

    await closeHandoff(h.deps, staff, id);
    expect((await getConversationView(h.deps, staff, id)).mode).toBe("bot");
  });

  it("outside the 24-hour window only an approved template can go", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const id = await h.receive("573400000012", "Hola", old);
    await expect(
      replyToConversation(h.deps, staff, id, { text: "¿Sigue ahí?", clientId: "form-0000002" }),
    ).rejects.toMatchObject({ code: "window_closed" });

    const view = await getConversationView(h.deps, staff, id);
    expect(view.window.open).toBe(false);
    await expect(
      sendTemplateToConversation(h.deps, staff, id, {
        templateKey: "recordatorio_cita",
        bookingId: null,
        clientId: "form-0000003",
      }),
    ).rejects.toMatchObject({ code: "booking_required" });

    const conversation = await getConversation(h.deps.db, id);
    await h.deps.db
      .update(contacts)
      .set({ name: "Laura Gómez" })
      .where(eq(contacts.id, conversation?.contactId ?? ""));
    const chair = await createResource(h.deps.db, {
      businessId: h.a.id,
      kind: "chair",
      name: "Sillón 1",
    });
    const booking = await insertBooking(h.deps.db, {
      businessId: h.a.id,
      contactId: conversation?.contactId ?? "",
      resourceId: chair.id,
      serviceKey: "limpieza",
      serviceName: "Limpieza dental",
      priceCop: 120000,
      subjectName: "Laura Gómez",
      partySize: null,
      startsAt: new Date("2030-01-10T15:00:00-05:00"),
      endsAt: new Date("2030-01-10T15:45:00-05:00"),
      source: "agent",
      notes: null,
    });
    await sendTemplateToConversation(h.deps, staff, id, {
      templateKey: "recordatorio_cita",
      bookingId: booking.id,
      clientId: "form-0000004",
    });
    const [request] = sentTo("573400000012");
    expect(request?.body.template).toMatchObject({
      name: "recordatorio_cita_v1",
      components: [
        {
          type: "body",
          parameters: [
            { text: "Laura Gómez" },
            { text: "Limpieza dental" },
            { text: "Clínica Dental Demo" },
            { text: "jueves 10 de enero" },
            { text: "3:00 p. m." },
          ],
        },
        {
          type: "button",
          parameters: [{ payload: expect.stringMatching(/^staff:[0-9a-f-]{36}:confirm$/) }],
        },
        { type: "button" },
      ],
    });
  });

  it("records staff consent (A13) and re-enables automatic messages (A2)", async () => {
    const id = await h.receive("573400000013", "PARA");
    const { contact } = await getConversationView(h.deps, staff, id);
    await h.deps.db
      .update(contacts)
      .set({ optedOutAt: new Date() })
      .where(eq(contacts.id, contact.id));
    await expect(
      recordConsent(h.deps, staff, contact.id, { confirmed: false }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await recordConsent(h.deps, staff, contact.id, { confirmed: true });
    await reenableAutomaticMessages(h.deps, staff, contact.id);
    const after = await getConversationView(h.deps, staff, id);
    expect(after.contact.consent).toMatchObject({ source: "staff" });
    expect(after.contact.optedOutAt).toBeNull();
  });

  it("takes a conversation over without writing", async () => {
    const id = await h.receive("573400000014", "Hola");
    await takeOverConversation(h.deps, staff, id);
    expect((await getConversationView(h.deps, staff, id)).mode).toBe("human");
  });

  it("can't open another business's conversation", async () => {
    const other = await h.actor("staff@b.co", { business: h.b, role: "business_staff" });
    const id = await h.receive("573400000015", "Hola");
    await expect(getConversationView(h.deps, other, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      replyToConversation(h.deps, other, id, { text: "hola", clientId: "form-0000005" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(closeHandoff(h.deps, other, id)).rejects.toBeInstanceOf(NotFoundError);
    const before = await h.deps.db.select().from(messages);
    expect(before.some((m) => m.body === "hola")).toBe(false);
  });
});

describe("notifications (A15)", () => {
  it("lists, counts and marks them read", async () => {
    for (const text of ["Pedro no ha confirmado", "Uso de IA al 90 %"]) {
      await notifyStaff(h.deps.db, { businessId: h.a.id, kind: "automation", text });
    }
    expect(await unreadNotificationCount(h.deps, staff)).toBe(2);
    const [first] = await listNotifications(h.deps, staff);
    await markRead(h.deps, staff, [first?.id ?? ""]);
    expect(await unreadNotificationCount(h.deps, staff)).toBe(1);
    await markRead(h.deps, staff, null);
    expect(await unreadNotificationCount(h.deps, staff)).toBe(0);
    expect((await listNotifications(h.deps, staff)).every((n) => n.read)).toBe(true);
  });
});
