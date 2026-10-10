import { ODONTOLOGIA_SAMPLE_CONFIG } from "@platform/db/testing";
import { auditLog, listResources } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ActionRefusedError, ForbiddenError } from "../errors.ts";
import { uiSchemaFor } from "../forms.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
  addClosure,
  addResource,
  editResource,
  getSetup,
  removeClosure,
  saveConfig,
  setHoliday,
} from "./setup.ts";

let h: Harness;
let admin: Actor;

beforeAll(async () => {
  h = await createHarness();
  admin = await h.actor("admin@a.co", { business: h.a, role: "business_admin" });
});

afterAll(async () => {
  await h.close();
});

describe("the generated setup form", () => {
  it("orders fields by section and x-ui order, with widgets, help and choice names", async () => {
    const view = await getSetup(h.deps, admin);
    const ui = view.form.uiSchema;
    expect((ui["ui:order"] as string[]).slice(0, 8)).toEqual([
      "business_name",
      "city",
      "address",
      "maps_url",
      "review_url",
      "phone_urgencias",
      "privacy_url",
      "hours",
    ]);
    expect(ui.hours).toEqual({ "ui:field": "weeklyHours", "ui:options": { section: "Horario" } });
    expect(ui.services).toMatchObject({ "ui:options": { section: "Servicios", layout: "table" } });
    // Postgres jsonb sorts object keys; the order comes back from the template's YAML.
    expect((ui.services as { items: Record<string, unknown> }).items["ui:order"]).toEqual([
      "key",
      "name",
      "price_type",
      "price_cop",
      "duration_min",
      "description",
      "bookable",
    ]);
    // Choices show the template's names; the stored value stays the code.
    expect((ui.services as { items: Record<string, unknown> }).items.price_type).toEqual({
      "ui:enumNames": {
        fixed: "Precio fijo",
        from: "Desde (precio mínimo)",
        after_evaluation: "Se define en la valoración",
      },
    });
    expect(ui.review_url).toMatchObject({
      "ui:help": "Se usa en el mensaje después de cada cita.",
    });
    expect(ui.policies).toMatchObject({ cancellation: { "ui:widget": "textarea" } });
    expect(view.form.schema.properties).toHaveProperty("hours");
    expect(view.resourceType).toEqual({ kind: "chair", label: "Sillón" });
    expect(view.consentPreview).toContain("Clínica Dental Demo");
    expect(uiSchemaFor({ type: "object" })).toEqual({ "ui:order": [] });
  });

  it("saves a valid config and audits which fields changed", async () => {
    const result = await saveConfig(h.deps, admin, {
      ...ODONTOLOGIA_SAMPLE_CONFIG,
      city: "Envigado",
    });
    expect(result).toEqual({ ok: true });
    expect((await getSetup(h.deps, admin)).form.config.city).toBe("Envigado");
    const [entry] = await h.core.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "config.update"));
    expect(entry).toMatchObject({
      businessId: h.a.id,
      actorUserId: admin.userId,
      payload: { changed: ["city"] },
    });
  });

  it("returns field errors with structured paths for an invalid config", async () => {
    const config = structuredClone(ODONTOLOGIA_SAMPLE_CONFIG) as {
      services: Record<string, unknown>[];
    };
    delete config.services[1]?.price_cop;
    const result = await saveConfig(h.deps, admin, config);
    expect(result).toEqual({
      ok: false,
      errors: [{ path: ["services", 1, "price_cop"], message: "is required" }],
    });
  });
});

describe("resources, closures and holidays", () => {
  it("adds and renames resources of the template's kind", async () => {
    await addResource(h.deps, admin, { name: " Sillón 1 " });
    await addResource(h.deps, admin, { name: "Sillón 2" });
    await expect(addResource(h.deps, admin, { name: "  " })).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    const [first] = await listResources(h.deps.db, h.a.id);
    await editResource(h.deps, admin, first?.id ?? "", { name: "Sillón A", active: false });
    const view = await getSetup(h.deps, admin);
    expect(view.resources.map((r) => [r.name, r.active])).toEqual([
      ["Sillón 2", true],
      ["Sillón A", false],
    ]);
  });

  it("blocks time and removes the block", async () => {
    await addClosure(h.deps, admin, {
      resourceId: null,
      from: "2027-01-04T08:00",
      to: "2027-01-08T18:00",
      reason: "Vacaciones",
    });
    await expect(
      addClosure(h.deps, admin, {
        resourceId: null,
        from: "2027-01-04T08:00",
        to: "2027-01-04T07:00",
        reason: null,
      }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    let view = await getSetup(h.deps, admin);
    expect(view.closures).toEqual([
      {
        id: expect.any(String),
        resourceName: null,
        from: "lunes 4 de enero, 8:00 a. m.",
        to: "viernes 8 de enero, 6:00 p. m.",
        reason: "Vacaciones",
      },
    ]);
    await removeClosure(h.deps, admin, view.closures[0]?.id ?? "");
    view = await getSetup(h.deps, admin);
    expect(view.closures).toEqual([]);
  });

  it("switches a holiday on and off", async () => {
    await setHoliday(h.deps, admin, "san_jose", true);
    let view = await getSetup(h.deps, admin);
    expect(view.holidays.find((x) => x.key === "san_jose")).toMatchObject({
      name: "San José",
      open: true,
    });
    expect(view.holidays).toHaveLength(19);
    await setHoliday(h.deps, admin, "san_jose", false);
    view = await getSetup(h.deps, admin);
    expect(view.holidays.every((x) => !x.open)).toBe(true);
  });

  it("is for business admins only", async () => {
    const staff = await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
    await expect(getSetup(h.deps, staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveConfig(h.deps, staff, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});
