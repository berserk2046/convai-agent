import { createTemplateApi, parseWebhook } from "@platform/channels";
import { webhookFixture, type FixtureName } from "@platform/channels/testing";
import { createChannelResolver, ingestWebhookEvents } from "@platform/core";
import { createCoreHarness, type CoreHarness } from "@platform/core/testing";
import {
  activateBusiness,
  listWaTemplates,
  upsertWaTemplate,
  waMessageTemplates,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileWaTemplates, type TemplateSyncDeps } from "./meta-templates.ts";

/**
 * Meta template submission (behind the flag) and status sync, against the fake Graph API.
 * The harness's channel is on WABA 102290129340398, the same account as Meta's recorded
 * template webhooks.
 */

let h: CoreHarness;
let deps: TemplateSyncDeps;
const WABA = "102290129340398";

beforeAll(async () => {
  h = await createCoreHarness();
  await activateBusiness(h.testDb.db, h.business.id);
  deps = {
    db: h.testDb.db,
    logger: h.deps.logger,
    secrets: h.deps.secrets,
    templates: createTemplateApi({ baseUrl: h.graph.url, graphVersion: "v24.0" }),
    now: () => new Date("2026-10-08T12:00:00-05:00"),
    submissionEnabled: false,
  };
});

afterAll(async () => {
  await h.close();
});

const rows = async () =>
  Object.fromEntries(
    (await listWaTemplates(h.testDb.db, h.business.id)).map((r) => [r.metaName, r]),
  );

async function webhook(name: FixtureName, change: (value: Record<string, unknown>) => void) {
  const payload = webhookFixture(name) as {
    entry: { changes: { value: Record<string, unknown> }[] }[];
  };
  const value = payload.entry[0]?.changes[0]?.value;
  if (!value) throw new Error("fixture shape");
  change(value);
  const parsed = parseWebhook(payload);
  if (!parsed.ok) throw new Error(parsed.error);
  return ingestWebhookEvents(
    {
      db: h.testDb.db,
      logger: h.deps.logger,
      resolveChannel: createChannelResolver(h.testDb.db),
      enqueue: () => Promise.resolve(),
    },
    parsed.events,
  );
}

describe("submission", () => {
  it("sends nothing to Meta while META_TEMPLATE_SUBMISSION is off", async () => {
    const before = h.graph.requests.length;
    expect(await reconcileWaTemplates(deps)).toEqual({ created: 0, edited: 0, updated: 0 });
    expect(h.graph.requests.length).toBe(before);
  });

  it("creates every template Meta doesn't have yet when it's on", async () => {
    h.graph.respondNext(
      { status: 200, body: { id: "9001", status: "PENDING", category: "MARKETING" } },
      { status: 200, body: { id: "9002", status: "PENDING", category: "UTILITY" } },
      { status: 200, body: { id: "9003", status: "PENDING", category: "UTILITY" } },
      { status: 200, body: { data: [], paging: { cursors: {} } } },
    );
    const before = h.graph.requests.length;
    const result = await reconcileWaTemplates({ ...deps, submissionEnabled: true });
    expect(result).toEqual({ created: 3, edited: 0, updated: 0 });
    const creates = h.graph.requests.slice(before).filter((r) => r.method === "POST");
    expect(creates.map((r) => [r.path, r.body.name, r.body.category])).toEqual([
      [`/v24.0/${WABA}/message_templates`, "control_6_meses_v1", "marketing"],
      [`/v24.0/${WABA}/message_templates`, "recordatorio_cita_v1", "utility"],
      [`/v24.0/${WABA}/message_templates`, "solicitud_resena_v1", "utility"],
    ]);
    expect(creates[1]?.body).toMatchObject({
      language: "es",
      parameter_format: "positional",
      components: [
        { type: "BODY", example: { body_text: [expect.any(Array)] } },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Confirmo" }, expect.anything()],
        },
      ],
    });
    const after = await rows();
    expect(after.recordatorio_cita_v1).toMatchObject({
      metaTemplateId: "9002",
      metaStatus: "PENDING",
    });

    // Nothing left to create on the next run.
    h.graph.respondNext({ status: 200, body: { data: [] } });
    const again = h.graph.requests.length;
    await reconcileWaTemplates({ ...deps, submissionEnabled: true });
    expect(h.graph.requests.slice(again).every((r) => r.method === "GET")).toBe(true);
  });
});

describe("status webhooks", () => {
  it("approve, reject and recategorize by name and language", async () => {
    await webhook("template-status-approved", (v) => {
      v.message_template_name = "recordatorio_cita_v1";
      v.message_template_language = "es";
    });
    await webhook("template-status-rejected", (v) => {
      v.message_template_name = "control_6_meses_v1";
      v.message_template_language = "es";
    });
    await webhook("template-category-changed", (v) => {
      v.message_template_name = "solicitud_resena_v1";
      v.message_template_language = "es";
    });
    const after = await rows();
    expect(after.recordatorio_cita_v1).toMatchObject({
      metaStatus: "APPROVED",
      categoryMeta: "UTILITY",
    });
    expect(after.control_6_meses_v1).toMatchObject({
      metaStatus: "REJECTED",
      rejectedReason: "INVALID_FORMAT",
      statusInfo: { rejection_info: { reason: expect.stringContaining("{{1}}{{2}}") } },
    });
    // B31: Meta moved the review request to MARKETING; caps and billing follow Meta.
    expect(after.solicitud_resena_v1?.categoryMeta).toBe("MARKETING");
    expect(h.logs.some((l) => l.alert === "wa_template_rejected")).toBe(true);
  });
});

describe("edits and adoption", () => {
  it("edits an approved template whose body changed in a minor version", async () => {
    const reminder = (await rows()).recordatorio_cita_v1;
    if (!reminder) throw new Error("missing");
    const edited = reminder.components.map((c) =>
      c.type === "BODY" ? { ...c, text: String(c.text).replace("Hola", "Buen día") } : c,
    );
    await h.testDb.db
      .update(waMessageTemplates)
      .set({ components: edited })
      .where(eq(waMessageTemplates.id, reminder.id));
    h.graph.respondNext(
      { status: 200, body: { success: true } },
      { status: 200, body: { data: [] } },
    );
    const before = h.graph.requests.length;
    const result = await reconcileWaTemplates({ ...deps, submissionEnabled: true });
    expect(result.edited).toBe(1);
    expect(h.graph.requests[before]).toMatchObject({
      method: "POST",
      path: "/v24.0/9002",
      body: { components: edited },
    });
    expect((await rows()).recordatorio_cita_v1?.submittedComponents).toEqual(edited);
  });

  it("adopts a template Meta already has with the same body, never a different one", async () => {
    const components = [{ type: "BODY", text: "Hola, gracias por escribirnos." }];
    for (const name of ["bienvenida_v1", "otra_v1"]) {
      await upsertWaTemplate(h.testDb.db, {
        businessId: h.business.id,
        templateKey: name.replace("_v1", ""),
        metaName: name,
        language: "es",
        categoryRequested: "UTILITY",
        components,
      });
    }
    const exists = {
      status: 400,
      body: {
        error: {
          message: "Content in this language already exists",
          code: 100,
          error_subcode: 2388024,
        },
      },
    };
    h.graph.respondNext(
      exists,
      {
        status: 200,
        body: {
          data: [
            {
              id: "7001",
              name: "bienvenida_v1",
              language: "es",
              status: "APPROVED",
              category: "UTILITY",
              components,
            },
            {
              id: "7002",
              name: "otra_v1",
              language: "es",
              status: "APPROVED",
              category: "UTILITY",
              components: [{ type: "BODY", text: "Otro texto" }],
            },
          ],
        },
      },
      exists,
      { status: 200, body: { data: [] } },
    );
    await reconcileWaTemplates({ ...deps, submissionEnabled: true });
    const after = await rows();
    expect(after.bienvenida_v1).toMatchObject({ metaTemplateId: "7001", metaStatus: "APPROVED" });
    expect(after.otra_v1?.metaTemplateId).toBeNull();
    expect(h.logs.some((l) => l.alert === "wa_template_name_taken")).toBe(true);
  });

  it("syncs statuses Meta changed without a webhook", async () => {
    h.graph.respondNext({
      status: 200,
      body: {
        data: [
          {
            id: "9002",
            name: "recordatorio_cita_v1",
            language: "es",
            status: "PAUSED",
            category: "UTILITY",
          },
        ],
      },
    });
    const result = await reconcileWaTemplates(deps);
    expect(result.updated).toBe(1);
    expect((await rows()).recordatorio_cita_v1?.metaStatus).toBe("PAUSED");
  });

  it("never stores a template id that JSON rounding may have changed", async () => {
    await webhook("template-status-approved", (v) => {
      v.message_template_name = "otra_v1";
      v.message_template_language = "es";
      // As the API parses it: past 2^53, JSON.parse rounds the number.
      v.message_template_id = JSON.parse("12345678901234567890") as number;
    });
    expect((await rows()).otra_v1).toMatchObject({ metaStatus: "APPROVED", metaTemplateId: null });

    h.graph.respondNext({
      status: 200,
      body: {
        data: [
          {
            id: "12345678901234567890",
            name: "otra_v1",
            language: "es",
            status: "APPROVED",
            category: "UTILITY",
          },
        ],
      },
    });
    await reconcileWaTemplates(deps);
    expect((await rows()).otra_v1?.metaTemplateId).toBe("12345678901234567890");
  });
});
