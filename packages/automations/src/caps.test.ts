import {
  automationRuns,
  bookings,
  businesses,
  contacts,
  listStaffNotifications,
  withTenant,
} from "@platform/db";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { updateAutomationSettings } from "./settings.ts";

/**
 * Checks that read message timestamps (monthly marketing counts, the 72-hour window for
 * typed button replies) compare them with the clock, so this file's clock is real time.
 */

let h: Harness;
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const ZONE = "America/Bogota";

beforeAll(async () => {
  h = await createHarness();
  h.setClock(NOW);
});

afterAll(async () => {
  await h.close();
});

describe("marketing cap (principle 10)", () => {
  it("skips marketing messages over the monthly cap and warns at 90% and at the cap (C3)", async () => {
    await h.core.testDb.db
      .update(businesses)
      .set({ limits: { marketing_msgs_month: 2 } })
      .where(eq(businesses.id, h.core.business.id));
    // The recall fires 180 days after last_cleaning_date at this minute (local time).
    const local = DateTime.fromJSDate(NOW, { zone: ZONE });
    await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      updateAutomationSettings(tx, h.core.business.id, "control_6_meses", {
        enabled: true,
        overrides: { "trigger.at_local_time": local.toFormat("HH:mm") },
      }),
    );
    const cleaned = local.minus({ days: 180 }).toISODate();
    const numbers = ["573200000001", "573200000002", "573200000003"];
    for (const [i, number] of numbers.entries()) {
      const contact = await h.patient(number, { name: `Paciente ${String(i + 1)}` });
      await h.core.testDb.db
        .update(contacts)
        .set({ fields: { last_cleaning_date: cleaned } })
        .where(eq(contacts.id, contact.id));
    }

    await h.tick(NOW);
    const sent = numbers.filter((n) => h.templatesTo(n).includes("control_6_meses_v1"));
    expect(sent).toHaveLength(2);
    const runs = await h.core.testDb.db.select().from(automationRuns);
    expect(runs.filter((r) => r.reason === "marketing_cap")).toHaveLength(1);

    const notes = await withTenant(h.core.testDb.db, h.core.business.id, (tx) =>
      listStaffNotifications(tx, h.core.business.id),
    );
    expect(
      notes
        .filter((n) => n.kind === "usage")
        .map((n) => n.payload.percent)
        .sort(),
    ).toEqual([100, 90]);
    expect(notes.map((n) => n.text)).toContain(
      "Se alcanzó el límite mensual de mensajes de marketing (2). Hasta el próximo mes no se envían más.",
    );
  });
});

describe('typing a button\'s text, e.g. "confirmo" (decision A11)', () => {
  it("counts as tapping it on the latest template of the past 72 hours", async () => {
    const laura = await h.patient("573200000010", { name: "Laura Gómez" });
    const booking = await h.book(laura, new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
    await h.tick(NOW);
    expect(h.templatesTo("573200000010")).toEqual(["recordatorio_cita_v1"]);

    h.setClock(new Date(NOW.getTime() + 60_000));
    const { llmRequests } = await h.receive("573200000010", { text: "Confirmo." });
    expect(llmRequests).toBe(0);
    const [row] = await h.core.testDb.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("confirmed");
    expect(h.textsTo("573200000010")).toEqual([
      "¡Gracias por confirmar, Laura Gómez! Le esperamos.",
    ]);
  });

  it("doesn't count once the agent has spoken since the template", async () => {
    const ana = await h.patient("573200000012", { name: "Ana Pérez" });
    const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const booking = await h.book(ana, later(27 * 60).toISOString());
    await h.tick(later(3 * 60));
    expect(h.templatesTo("573200000012")).toEqual(["recordatorio_cita_v1"]);
    h.setClock(later(3 * 60 + 1));
    await h.receive("573200000012", { text: "¿Tienen cupo para mi hijo también?" }, [
      { text: "Sí. ¿Le propongo jueves a las 3:00 p. m.? Responda Confirmo para agendarla." },
    ]);
    h.setClock(later(3 * 60 + 2));
    const { llmRequests } = await h.receive("573200000012", { text: "Confirmo" }, [
      { text: "Perfecto, ya la agendo." },
    ]);
    expect(llmRequests).toBe(1);
    const [row] = await h.core.testDb.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row?.status).toBe("pending");
  });

  it("other words go to the agent as usual", async () => {
    const pedro = await h.patient("573200000011", { name: "Pedro Ruiz" });
    await h.book(pedro, new Date(NOW.getTime() + 25 * 3_600_000).toISOString());
    h.setClock(new Date(NOW.getTime() + 3_600_000));
    await h.tick(h.now());
    const { llmRequests } = await h.receive("573200000011", { text: "Confirmo pero llego tarde" }, [
      { text: "Gracias por avisar. ¿Cuántos minutos cree que tardará?" },
    ]);
    expect(llmRequests).toBe(1);
  });
});
