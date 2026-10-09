import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WhatsAppSendError } from "./errors.ts";
import { TEMPLATE_EXISTS_SUBCODE, createTemplateApi, type TemplateApi } from "./templates.ts";
import { startFakeGraph, type FakeGraph } from "./testing.ts";

let graph: FakeGraph;
let api: TemplateApi;
const auth = { wabaId: "102290129340398", accessToken: "EAAG-secret-token" };
const components = [
  { type: "BODY", text: "Hola {{1}}", example: { body_text: [["Laura"]] } },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmo" }] },
];

beforeAll(async () => {
  graph = await startFakeGraph();
  api = createTemplateApi({ baseUrl: graph.url, graphVersion: "v24.0" });
});

afterAll(async () => {
  await graph.close();
});

describe("template API", () => {
  it("creates a positional template and returns Meta's id, status and category", async () => {
    graph.respondNext({
      status: 200,
      body: { id: "546151681022936", status: "PENDING", category: "UTILITY" },
    });
    const created = await api.create(auth, {
      name: "recordatorio_cita_v1",
      language: "es",
      category: "UTILITY",
      components,
    });
    expect(created).toEqual({ id: "546151681022936", status: "PENDING", category: "UTILITY" });
    expect(graph.requests.at(-1)).toEqual({
      method: "POST",
      path: "/v24.0/102290129340398/message_templates",
      authorization: "Bearer EAAG-secret-token",
      body: {
        name: "recordatorio_cita_v1",
        language: "es",
        category: "utility",
        parameter_format: "positional",
        components,
      },
    });
  });

  it("reports a name that already exists with Meta's subcode", async () => {
    graph.respondNext({
      status: 400,
      body: {
        error: {
          message: "Content in this language already exists",
          type: "OAuthException",
          code: 100,
          error_subcode: TEMPLATE_EXISTS_SUBCODE,
          fbtrace_id: "Abc",
        },
      },
    });
    const error = await api
      .create(auth, { name: "x_v1", language: "es", category: "UTILITY", components })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect(error).toMatchObject({ kind: "permanent", code: 100, subcode: TEMPLATE_EXISTS_SUBCODE });
  });

  it("edits by template id, replacing the components", async () => {
    graph.respondNext({ status: 200, body: { success: true } });
    await api.edit(auth.accessToken, "564750795574598", components);
    expect(graph.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v24.0/564750795574598",
      body: { components },
    });
  });

  it("lists every page with the cursor", async () => {
    graph.respondNext(
      {
        status: 200,
        body: {
          data: [
            { id: "1", name: "a_v1", language: "es", status: "APPROVED", category: "UTILITY" },
          ],
          paging: {
            cursors: { before: "B", after: "CURSOR1" },
            next: "https://graph.facebook.com/next",
          },
        },
      },
      {
        status: 200,
        body: {
          data: [
            { id: "2", name: "b_v1", language: "es", status: "PENDING", category: "MARKETING" },
          ],
          paging: { cursors: { before: "B2", after: "CURSOR2" } },
        },
      },
    );
    const list = await api.list(auth);
    expect(list.map((t) => [t.id, t.name, t.status])).toEqual([
      ["1", "a_v1", "APPROVED"],
      ["2", "b_v1", "PENDING"],
    ]);
    const [first, second] = graph.requests.slice(-2);
    expect(first?.method).toBe("GET");
    expect(first?.path).toBe(
      "/v24.0/102290129340398/message_templates?fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Ccomponents&limit=100",
    );
    expect(second?.path).toContain("&after=CURSOR1");
  });
});
