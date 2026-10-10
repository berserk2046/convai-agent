import {
  InvalidInputError,
  activateBusiness,
  applyWaTemplateUpdate,
  withTenant,
} from "@platform/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ForbiddenError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
  durationLabel,
  listBusinessAutomations,
  setAutomationEnabled,
  setAutomationTiming,
} from "./automations.ts";

let h: Harness;
let admin: Actor;

beforeAll(async () => {
  h = await createHarness();
  admin = await h.actor("admin@a.co", { business: h.a });
});

afterAll(async () => {
  await h.close();
});

const rule = async (key: string) =>
  (await listBusinessAutomations(h.deps, admin)).find((r) => r.key === key);

describe("/automations", () => {
  it("describes each rule in Spanish, with a preview filled with sample data", async () => {
    const rules = await listBusinessAutomations(h.deps, admin);
    expect(rules.map((r) => [r.key, r.enabled, r.when])).toEqual([
      ["recordatorio_24h", true, "24 horas antes de la cita"],
      ["sin_confirmar", true, "15 horas antes de la cita"],
      ["actualizar_ultima_limpieza", true, "Al terminar la cita"],
      ["resena_post_cita", true, "2 horas después de terminar la cita"],
      ["control_6_meses", false, "180 días después de «Última limpieza», a las 10:00"],
    ]);
    const reminder = rules[0];
    expect(reminder?.message).toMatchObject({
      kind: "template",
      buttons: ["Confirmo", "Necesito cambiar"],
      meta: { name: "recordatorio_cita_v1", status: null, category: "UTILITY" },
      blocked: true,
    });
    expect(reminder?.message?.preview).toMatch(
      /^Hola Laura Gómez, le recordamos su cita de Valoración en Clínica Dental Demo el \S+ \d+ de \S+ a las 10:00 a\. m\./u,
    );
    expect(rules[1]?.message).toMatchObject({ kind: "staff" });
    expect(rules[2]?.does).toBe("Actualiza «Última limpieza» del cliente");
    expect(reminder?.timing).toEqual([
      { param: "trigger.offset", value: "-24h", templateValue: "-24h", label: "Cuándo" },
    ]);
  });

  it("shows a template unblocked once Meta approves it", async () => {
    await activateBusiness(h.deps.db, h.a.id);
    await withTenant(h.deps.db, h.a.id, (tx) =>
      applyWaTemplateUpdate(
        tx,
        h.a.id,
        { name: "recordatorio_cita_v1", language: "es", metaTemplateId: "1" },
        { status: "APPROVED", at: new Date() },
      ),
    );
    expect((await rule("recordatorio_24h"))?.message).toMatchObject({
      meta: { status: "APPROVED" },
      blocked: false,
    });
  });

  it("turns rules on and off and changes allowed timing", async () => {
    await setAutomationEnabled(h.deps, admin, "control_6_meses", true);
    expect((await rule("control_6_meses"))?.enabled).toBe(true);
    await setAutomationTiming(h.deps, admin, "recordatorio_24h", { "trigger.offset": "-48h" });
    expect(await rule("recordatorio_24h")).toMatchObject({
      when: "48 horas antes de la cita",
      timing: [{ value: "-48h", templateValue: "-24h" }],
    });
    await expect(
      setAutomationTiming(h.deps, admin, "recordatorio_24h", { "trigger.offset": "2h" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      setAutomationTiming(h.deps, admin, "sin_confirmar", { "trigger.offset": "-10h" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    // Back to the template's value: the override is dropped.
    await setAutomationTiming(h.deps, admin, "recordatorio_24h", { "trigger.offset": "-24h" });
    expect((await rule("recordatorio_24h"))?.timing[0]?.value).toBe("-24h");
  });

  it("is for business admins only", async () => {
    const staff = await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
    await expect(listBusinessAutomations(h.deps, staff)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("labels durations in Spanish, in the unit the template uses", () => {
    expect(["-24h", "1h", "90m", "180d", "1d"].map(durationLabel)).toEqual([
      "24 horas",
      "1 hora",
      "90 minutos",
      "180 días",
      "1 día",
    ]);
  });
});
