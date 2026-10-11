import {
  InvalidInputError,
  businesses,
  createResource,
  getBusiness,
  listAutomations,
  recordUsage,
} from "@platform/db";
import {
  ODONTOLOGIA_SAMPLE_CONFIG,
  ODONTOLOGIA_SOURCE,
  ODONTOLOGIA_VERSION as CURRENT,
  laterVersion,
  odontologiaAt,
  recordPassingEvalRun,
} from "@platform/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { login, resolveSession } from "../auth.ts";
import { ActionRefusedError, ForbiddenError } from "../errors.ts";
import { PASSWORD, createHarness, type Harness } from "../harness.ts";
import { saveConfig } from "../business/setup.ts";
import {
  activate,
  addBusinessUser,
  businessDetail,
  connectChannel,
  createBusinessFromTemplate,
  listBusinesses,
  publishedTemplates,
  removeBusinessUser,
  resetUserPassword,
  setPaused,
  updateSettings,
  upgrade,
  upgradePreview,
} from "./businesses.ts";
import {
  deprecateTemplate,
  listTemplates,
  publishTemplate,
  templateDetail,
  uploadTemplate,
} from "./templates.ts";
import { usageReport } from "./usage.ts";

let h: Harness;
let owner: Actor;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.actor("owner@platform.co", { owner: true });
});

afterAll(async () => {
  await h.close();
});

/**
 * The next major odontologia: a new required config field (a breaking change, so a major
 * version, decision A16) and a changed system prompt.
 */
const NEXT_MAJOR = laterVersion("major");
const V2 = odontologiaAt(NEXT_MAJOR)
  .replace(
    "    booking_notice_hours:\n",
    "    whatsapp_firma:\n      type: string\n      title: Firma de los mensajes\n      x-ui: { section: General, order: 8 }\n    booking_notice_hours:\n",
  )
  .replace(
    "required: [business_name, city, address, phone_urgencias, hours, services, payment_methods]",
    "required: [business_name, city, address, phone_urgencias, hours, services, payment_methods, whatsapp_firma]",
  )
  .replace(
    "  booking_notice_hours: 2\n",
    "  booking_notice_hours: 2\n  whatsapp_firma: Equipo Demo\n",
  )
  .replace("Tu trabajo es responder preguntas", "Tu trabajo es atender preguntas");

describe("templates (platform owner)", () => {
  it("lists versions, refuses invalid uploads with paths and lines, stores valid drafts", async () => {
    expect(await listTemplates(h.deps, owner)).toEqual([
      expect.objectContaining({
        slug: "odontologia",
        versions: [expect.objectContaining({ version: CURRENT, status: "published" })],
      }),
    ]);
    const broken = await uploadTemplate(
      h.deps,
      owner,
      ODONTOLOGIA_SOURCE.replace("max_reply_words: 60", "max_reply_words: 5"),
    );
    expect(broken).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ path: "agent.max_reply_words", line: expect.any(Number) }),
      ],
    });
    expect(await uploadTemplate(h.deps, owner, ODONTOLOGIA_SOURCE)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "manifest.version",
          message: expect.stringContaining("published"),
        }),
      ],
    });
    expect(await uploadTemplate(h.deps, owner, V2)).toEqual({
      ok: true,
      slug: "odontologia",
      version: NEXT_MAJOR,
      warnings: [],
    });
  });

  it("shows a version's diff against the previous one, then publishes it", async () => {
    const detail = await templateDetail(h.deps, owner, "odontologia", NEXT_MAJOR);
    expect(detail).toMatchObject({ status: "draft", previous: CURRENT, businessesPinned: 0 });
    expect(detail.diff.map((d) => d.section)).toEqual(
      ["manifest", "config_schema", "agent", "evals"].filter((s) =>
        detail.diff.some((d) => d.section === s),
      ),
    );
    const agent = detail.diff.find((d) => d.section === "agent");
    expect(agent?.lines).toContainEqual({
      kind: "added",
      text: expect.stringContaining("Tu trabajo es atender preguntas"),
    });
    expect(agent?.lines).toContainEqual({
      kind: "removed",
      text: expect.stringContaining("Tu trabajo es responder preguntas"),
    });

    // Spec §10: no publishing without a live eval run of this upload that passes the gate.
    await expect(publishTemplate(h.deps, owner, "odontologia", NEXT_MAJOR)).rejects.toMatchObject({
      code: "evals_required",
      message: expect.stringContaining("Run the evals first") as unknown,
    });
    await recordPassingEvalRun(h.deps.db, "odontologia", NEXT_MAJOR);
    expect(
      (await templateDetail(h.deps, owner, "odontologia", NEXT_MAJOR)).evals.blocker,
    ).toBeNull();
    await publishTemplate(h.deps, owner, "odontologia", NEXT_MAJOR);
    await expect(publishTemplate(h.deps, owner, "odontologia", NEXT_MAJOR)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    expect((await publishedTemplates(h.deps, owner)).map((t) => t.version)).toEqual([
      NEXT_MAJOR,
      CURRENT,
    ]);
  });

  it("is for the platform owner only", async () => {
    const admin = await h.actor("admin@a.co", { business: h.a });
    await expect(listTemplates(h.deps, admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uploadTemplate(h.deps, admin, V2)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deprecateTemplate(h.deps, admin, "odontologia", CURRENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listBusinesses(h.deps, admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(usageReport(h.deps, admin, "2026-10")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("businesses (platform owner)", () => {
  let id: string;

  it("creates a business from a published template, seeded with its automation rules", async () => {
    ({ businessId: id } = await createBusinessFromTemplate(h.deps, owner, {
      name: "Clínica Nueva",
      templateSlug: "odontologia",
      templateVersion: CURRENT,
    }));
    expect((await listBusinesses(h.deps, owner)).find((b) => b.id === id)).toMatchObject({
      status: "setup",
      template: `odontologia@${CURRENT}`,
      displayPhone: null,
    });
    expect(await listAutomations(h.deps.db, id)).toHaveLength(5);
  });

  it("activates only once the checklist's required items are done", async () => {
    let detail = await businessDetail(h.deps, owner, id);
    expect(detail.checklist.map((c) => [c.key, c.done, c.required])).toEqual([
      ["config", false, true],
      ["resources", false, true],
      ["channel", false, true],
      ["users", false, false],
      ["templates", false, false],
    ]);
    await expect(activate(h.deps, owner, id)).rejects.toMatchObject({ code: "checklist" });

    await addBusinessUser(h.deps, owner, id, {
      email: "dueña@nueva.co",
      name: "Dueña",
      role: "business_admin",
      password: "temporal-12345",
    });
    const result = await login(h.deps, {
      email: "dueña@nueva.co",
      password: "temporal-12345",
      ip: null,
    });
    const admin = result.ok ? await resolveSession(h.deps, result.token) : null;
    if (!admin) throw new Error("no admin");
    expect(admin.business).toMatchObject({ id, role: "business_admin" });
    expect(await saveConfig(h.deps, admin, ODONTOLOGIA_SAMPLE_CONFIG)).toEqual({ ok: true });
    await createResource(h.deps.db, { businessId: id, kind: "chair", name: "Sillón 1" });
    await connectChannel(h.deps, owner, id, {
      phoneNumberId: "555000111",
      wabaId: "777000111",
      displayPhone: "+57 300 000 0000",
      accessToken: "EAAG-secret",
    });
    await activate(h.deps, owner, id);
    detail = await businessDetail(h.deps, owner, id);
    expect(detail.business.status).toBe("active");
    expect(detail.channel).toEqual({
      phoneNumberId: "555000111",
      wabaId: "777000111",
      displayPhone: "+57 300 000 0000",
    });
    expect(detail.waTemplates.map((t) => t.name).sort()).toEqual([
      "control_6_meses_v1",
      "recordatorio_cita_v1",
      "solicitud_resena_v1",
    ]);
    expect(detail.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "business.create",
        "business.channel",
        "business.activate",
        "user.create",
        "config.update",
      ]),
    );
    expect(JSON.stringify(detail.audit)).not.toContain("EAAG-secret");
  });

  it("manages users, caps, plan price and pausing", async () => {
    await addBusinessUser(h.deps, owner, id, {
      email: "admin@a.co",
      name: "x",
      role: "business_staff",
      password: "",
    });
    expect((await businessDetail(h.deps, owner, id)).users.map((u) => [u.email, u.role])).toEqual([
      ["dueña@nueva.co", "business_admin"],
      ["admin@a.co", "business_staff"],
    ]);
    const staff = (await businessDetail(h.deps, owner, id)).users.find(
      (u) => u.email === "admin@a.co",
    );
    const before = await login(h.deps, { email: "admin@a.co", password: PASSWORD, ip: null });
    if (!before.ok) throw new Error("login failed");
    await resetUserPassword(h.deps, owner, id, staff?.userId ?? "", "otra-clave-larga");
    // A reset ends every session the user had.
    expect(await resolveSession(h.deps, before.token)).toBeNull();
    expect(
      (await login(h.deps, { email: "admin@a.co", password: "otra-clave-larga", ip: null })).ok,
    ).toBe(true);
    await removeBusinessUser(h.deps, owner, id, staff?.userId ?? "");
    expect((await businessDetail(h.deps, owner, id)).users).toHaveLength(1);

    await updateSettings(h.deps, owner, id, {
      limits: { llm_usd_month: 25, marketing_msgs_month: 300 },
      planPriceUsd: 49,
    });
    await expect(
      updateSettings(h.deps, owner, id, { limits: { llm_usd_month: -1 } }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect((await businessDetail(h.deps, owner, id)).business).toMatchObject({
      limits: { llm_usd_month: 25, marketing_msgs_month: 300 },
      planPriceUsd: 49,
    });
    await setPaused(h.deps, owner, id, true);
    expect((await getBusiness(h.deps.db, id))?.status).toBe("paused");
    await setPaused(h.deps, owner, id, false);
    expect((await getBusiness(h.deps.db, id))?.status).toBe("active");
  });

  it("upgrades: shows the diff and the fields the new version needs, then pins it", async () => {
    expect((await businessDetail(h.deps, owner, id)).upgrades).toEqual([NEXT_MAJOR]);
    const preview = await upgradePreview(h.deps, owner, id, NEXT_MAJOR);
    expect(preview.configErrors).toEqual([{ path: ["whatsapp_firma"], message: "is required" }]);
    expect(preview.form.uiSchema["ui:order"]).toContain("whatsapp_firma");
    await expect(upgrade(h.deps, owner, id, NEXT_MAJOR)).rejects.toBeInstanceOf(InvalidInputError);
    await upgrade(h.deps, owner, id, NEXT_MAJOR, {
      ...ODONTOLOGIA_SAMPLE_CONFIG,
      whatsapp_firma: "Equipo Nuevo",
    });
    const [row] = await h.deps.db.select().from(businesses).where(eq(businesses.id, id));
    expect(row).toMatchObject({
      templateVersion: NEXT_MAJOR,
      config: expect.objectContaining({ whatsapp_firma: "Equipo Nuevo" }),
    });
  });
});

describe("usage (platform owner)", () => {
  it("adds up AI and WhatsApp spend per business against its plan price", async () => {
    const id =
      (await listBusinesses(h.deps, owner)).find((b) => b.name === "Clínica Nueva")?.id ?? "";
    await recordUsage(h.deps.db, { businessId: id, kind: "llm", units: 1, costUsd: 3.5 });
    await recordUsage(h.deps.db, {
      businessId: id,
      kind: "wa_marketing",
      units: 1,
      costUsd: 0.0125,
    });
    await recordUsage(h.deps.db, { businessId: id, kind: "wa_utility", units: 1, costUsd: 0.0008 });
    const month = new Date().toISOString().slice(0, 7);
    const report = await usageReport(h.deps, owner, month);
    expect(report.rows.find((r) => r.businessId === id)).toMatchObject({
      aiUsd: 3.5,
      whatsapp: { marketing: 0.0125, utility: 0.0008, authentication: 0, service: 0 },
      planPriceUsd: 49,
    });
    const row = report.rows.find((r) => r.businessId === id);
    expect(row?.marginUsd).toBeCloseTo(49 - 3.5133, 6);
    expect(report.rows.find((r) => r.businessId === h.b.id)?.planPriceUsd).toBeNull();
  });
});
