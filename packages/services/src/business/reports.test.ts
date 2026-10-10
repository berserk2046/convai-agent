import {
  bookings,
  createResource,
  finishRun,
  insertBooking,
  insertRuns,
  listAutomations,
  openHandoff,
  recordUsage,
  upsertContact,
  withTenant,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ForbiddenError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import { monthLabel, monthlyReport } from "./reports.ts";

let h: Harness;
let admin: Actor;
const NOW = new Date();
const month = DateTime.fromJSDate(NOW, { zone: "America/Bogota" }).toFormat("yyyy-MM");

beforeAll(async () => {
  h = await createHarness();
  admin = await h.actor("admin@a.co", { business: h.a });
});

afterAll(async () => {
  await h.close();
});

describe("/reports", () => {
  it("summarizes the month", async () => {
    await h.receive("573500000001", "Hola");
    await h.receive("573500000002", "¿Precio de la limpieza?");
    const handedOff = await h.receive("573500000003", "Quiero hablar con alguien");
    await withTenant(h.deps.db, h.a.id, (tx) =>
      openHandoff(tx, {
        businessId: h.a.id,
        conversationId: handedOff,
        reason: "pide_humano",
        summary: null,
      }),
    );

    const chair = await createResource(h.deps.db, {
      businessId: h.a.id,
      kind: "chair",
      name: "S1",
    });
    const contact = await upsertContact(h.deps.db, h.a.id, "573500000001");
    const start = DateTime.fromJSDate(NOW, { zone: "America/Bogota" })
      .startOf("month")
      .plus({ days: 1, hours: 9 });
    const book = (hours: number, source: "agent" | "staff") =>
      insertBooking(h.deps.db, {
        businessId: h.a.id,
        contactId: contact.id,
        resourceId: chair.id,
        serviceKey: "limpieza",
        serviceName: "Limpieza dental",
        priceCop: 120000,
        subjectName: "Ana",
        partySize: null,
        startsAt: start.plus({ hours }).toJSDate(),
        endsAt: start.plus({ hours, minutes: 45 }).toJSDate(),
        source,
        notes: null,
      });
    const confirmed = await book(0, "agent");
    const noShow = await book(1, "agent");
    await book(2, "staff");
    await h.deps.db
      .update(bookings)
      .set({ status: "confirmed", confirmedAt: NOW })
      .where(eq(bookings.id, confirmed.id));
    await h.deps.db.update(bookings).set({ status: "no_show" }).where(eq(bookings.id, noShow.id));

    const reminder = (await listAutomations(h.deps.db, h.a.id)).find(
      (a) => a.ruleKey === "recordatorio_24h",
    );
    const [run] = await insertRuns(h.deps.db, [
      {
        businessId: h.a.id,
        automationId: reminder?.id ?? "",
        subjectType: "booking",
        subjectId: confirmed.id,
        occurrenceKey: "x",
        dueAt: NOW,
      },
    ]);
    await finishRun(h.deps.db, run?.id ?? "", { status: "sent" });
    await recordUsage(h.deps.db, { businessId: h.a.id, kind: "llm", units: 1000, costUsd: 0.5 });
    await recordUsage(h.deps.db, {
      businessId: h.a.id,
      kind: "wa_utility",
      units: 1,
      costUsd: 0.0008,
    });

    const report = await monthlyReport(h.deps, admin, month);
    expect(report).toMatchObject({
      month,
      conversations: 3,
      resolvedWithoutHandoff: 2,
      resolvedPercent: 67,
      handoffsByReason: [{ reason: "pide_humano", label: "Pide hablar con una persona", count: 1 }],
      bookings: { agent: 2, staff: 1, external: 0 },
      appointments: { total: 3, confirmed: 1, noShows: 1, cancelled: 0 },
      costs: { aiUsd: 0.5, whatsappUsd: 0.0008, byKind: { llm: 0.5, wa_utility: 0.0008 } },
    });
    expect(report.automations.find((a) => a.key === "recordatorio_24h")?.count).toBe(1);
    expect(report.automations).toHaveLength(5);
  });

  it("is empty for a month without activity, and admin-only", async () => {
    const empty = await monthlyReport(h.deps, admin, "2020-01");
    expect(empty).toMatchObject({
      label: "enero de 2020",
      conversations: 0,
      resolvedPercent: null,
      previous: "2019-12",
      next: "2020-02",
    });
    const staff = await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
    await expect(monthlyReport(h.deps, staff, month)).rejects.toBeInstanceOf(ForbiddenError);
    expect(monthLabel("2026-10")).toBe("octubre de 2026");
  });
});
