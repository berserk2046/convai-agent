import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessNotFoundError, InvalidInputError, TemplateNotPublishedError } from "../errors.ts";
import { withTenant } from "../tenant.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import {
  createBusiness,
  getBusiness,
  setHolidayOpen,
  updateBusinessConfig,
  updateBusinessHolidays,
} from "./businesses.ts";
import { ODONTOLOGIA_SAMPLE_CONFIG, ODONTOLOGIA_SOURCE, publishOdontologia } from "./fixtures.ts";
import { saveTemplateDraft } from "./templates.ts";

let testDb: TestDatabase;
const sampleConfig = ODONTOLOGIA_SAMPLE_CONFIG;
const pinned = { templateSlug: "odontologia", templateVersion: "1.0.0" };

beforeAll(async () => {
  testDb = await createTestDatabase();
  await publishOdontologia(testDb.db);
});

afterAll(async () => {
  await testDb.drop();
});

function withoutPrice() {
  const config = structuredClone(sampleConfig) as { services: Record<string, unknown>[] };
  delete config.services[0]?.price_cop;
  return config;
}

describe("createBusiness", () => {
  it("pins a published template and stores the config with defaults applied", async () => {
    const business = await createBusiness(testDb.db, {
      name: "Clínica Demo",
      ...pinned,
      config: sampleConfig,
    });
    expect(business).toMatchObject({
      status: "setup",
      timezone: "America/Bogota",
      limits: {},
      holidays: {},
    });
    const services = business.config?.services as Record<string, unknown>[];
    expect(services[0]).toMatchObject({ key: "valoracion", bookable: true });
    expect(services.find((s) => s.key === "endodoncia")?.bookable).toBe(false);
  });

  it("can start without a config while in setup", async () => {
    const business = await createBusiness(testDb.db, { name: "Sin configurar", ...pinned });
    expect(business.config).toBeNull();
  });

  it("refuses drafts and unknown versions", async () => {
    await saveTemplateDraft(testDb.db, {
      sourceYaml: ODONTOLOGIA_SOURCE.replace(/^ {2}version: 1\.0\.0$/m, "  version: 1.1.0"),
    });
    await expect(
      createBusiness(testDb.db, {
        name: "X",
        templateSlug: "odontologia",
        templateVersion: "1.1.0",
      }),
    ).rejects.toBeInstanceOf(TemplateNotPublishedError);
    await expect(
      createBusiness(testDb.db, {
        name: "X",
        templateSlug: "veterinaria",
        templateVersion: "1.0.0",
      }),
    ).rejects.toBeInstanceOf(TemplateNotPublishedError);
  });

  it("rejects an invalid config with field paths", async () => {
    const error = await createBusiness(testDb.db, {
      name: "X",
      ...pinned,
      config: withoutPrice(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual([
      { path: "services[0].price_cop", message: "is required" },
    ]);
  });

  it("rejects bad names, timezones and limits", async () => {
    const error = await createBusiness(testDb.db, {
      name: "  ",
      ...pinned,
      timezone: "Bogota",
      limits: { llm_usd_month: -5 },
    }).catch((e: unknown) => e);
    expect((error as InvalidInputError).issues.map((i) => i.path)).toEqual([
      "name",
      "timezone",
      "limits.llm_usd_month",
    ]);
  });
});

describe("updateBusinessConfig", () => {
  it("validates every write against the pinned template", async () => {
    const business = await createBusiness(testDb.db, { name: "Clínica", ...pinned });
    const updated = await updateBusinessConfig(testDb.db, business.id, {
      ...sampleConfig,
      city: "Envigado",
    });
    expect(updated.config?.city).toBe("Envigado");

    await expect(
      updateBusinessConfig(testDb.db, business.id, withoutPrice()),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect((await getBusiness(testDb.db, business.id))?.config?.city).toBe("Envigado");
  });

  it("can't activate a business that has no config (DB constraint)", async () => {
    const business = await createBusiness(testDb.db, { name: "Pendiente", ...pinned });
    await expect(
      testDb.pool.query("UPDATE businesses SET status = 'active' WHERE id = $1", [business.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("holidays (spec review C2)", () => {
  it("stores the holidays a business opens on every year, sorted and without repeats", async () => {
    const business = await createBusiness(testDb.db, {
      name: "Abre festivos",
      ...pinned,
      holidays: { open_holidays: ["san_jose", "diversidad_etnica_y_cultural", "san_jose"] },
    });
    expect(business.holidays).toEqual({
      open_holidays: ["diversidad_etnica_y_cultural", "san_jose"],
    });
  });

  it("rejects keys that aren't Colombian public holidays", async () => {
    const error = await createBusiness(testDb.db, {
      name: "X",
      ...pinned,
      holidays: { open_holidays: ["san_jose", "halloween"] },
    }).catch((e: unknown) => e);
    expect((error as InvalidInputError).issues).toEqual([
      { path: "holidays.open_holidays[1]", message: "is not a Colombian public holiday" },
    ]);
  });

  it("switches holidays on and off inside the business's tenant scope", async () => {
    const business = await createBusiness(testDb.db, { name: "Clínica festivos", ...pinned });
    const toggle = (key: string, open: boolean) =>
      withTenant(testDb.db, business.id, (tx) => setHolidayOpen(tx, business.id, key, open));
    await toggle("inmaculada_concepcion", true);
    await toggle("san_jose", true);
    expect((await toggle("inmaculada_concepcion", false)).holidays).toEqual({
      open_holidays: ["san_jose"],
    });
    await expect(toggle("halloween", true)).rejects.toBeInstanceOf(InvalidInputError);

    const other = await createBusiness(testDb.db, { name: "Otra", ...pinned });
    await expect(
      withTenant(testDb.db, other.id, (tx) =>
        updateBusinessHolidays(tx, business.id, { open_holidays: [] }),
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);
    expect((await getBusiness(testDb.db, business.id))?.holidays).toEqual({
      open_holidays: ["san_jose"],
    });
  });
});
