import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWhatsAppClient, type WhatsAppClient } from "./client.ts";
import { WhatsAppSendError } from "./errors.ts";
import { FAKE_GRAPH_REQUESTS_PATH, startFakeGraph, type FakeGraph } from "./testing.ts";

let graph: FakeGraph;
let client: WhatsAppClient;
const sender = { phoneNumberId: "106540352242922", accessToken: "EAAG-secret-token" };

beforeAll(async () => {
  graph = await startFakeGraph();
  client = createWhatsAppClient({ baseUrl: graph.url, graphVersion: "v24.0" });
});

afterAll(async () => {
  await graph.close();
});

async function failure(promise: Promise<unknown>): Promise<WhatsAppSendError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof WhatsAppSendError)) throw new Error("expected a WhatsAppSendError");
  return error;
}

describe("sendText", () => {
  it("posts Meta's text message body to the configured version and returns the wamid", async () => {
    const result = await client.sendText(sender, { to: "573001234567", body: "Hola" });
    expect(result).toEqual({
      waMessageId: expect.stringMatching(/^wamid\./),
      messageStatus: "accepted",
    });
    expect(graph.requests.at(-1)).toEqual({
      method: "POST",
      path: "/v24.0/106540352242922/messages",
      authorization: "Bearer EAAG-secret-token",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "573001234567",
        type: "text",
        text: { body: "Hola", preview_url: false },
      },
    });
  });
});

describe("sendTemplate", () => {
  it("sends body parameters and quick-reply payloads as components", async () => {
    await client.sendTemplate(sender, {
      to: "573001234567",
      name: "recordatorio_cita_v1",
      languageCode: "es",
      bodyParameters: ["Laura", "Limpieza dental"],
      quickReplyPayloads: ["recordatorio_24h:run-1:confirm", "recordatorio_24h:run-1:reschedule"],
    });
    expect(graph.requests.at(-1)?.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001234567",
      type: "template",
      template: {
        name: "recordatorio_cita_v1",
        language: { code: "es" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Laura" },
              { type: "text", text: "Limpieza dental" },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: "recordatorio_24h:run-1:confirm" }],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "1",
            parameters: [{ type: "payload", payload: "recordatorio_24h:run-1:reschedule" }],
          },
        ],
      },
    });
  });

  it("omits the body component when the template has no variables", async () => {
    await client.sendTemplate(sender, {
      to: "1",
      name: "x_v1",
      languageCode: "es",
      bodyParameters: [],
      quickReplyPayloads: [],
    });
    expect(graph.requests.at(-1)?.body.template).toEqual({
      name: "x_v1",
      language: { code: "es" },
      components: [],
    });
  });
});

describe("errors", () => {
  const metaError = (code: number, status: number) => ({
    status,
    body: {
      error: {
        message: `(#${code}) problem`,
        type: "OAuthException",
        code,
        error_data: { messaging_product: "whatsapp", details: "details here" },
        error_subcode: 2494055,
        fbtrace_id: "Az8or2yhqkZfEZ",
      },
    },
  });

  it.each([
    [130429, 429, "transient"],
    [131000, 500, "transient"],
    [131047, 400, "permanent"],
    [131026, 400, "permanent"],
    [132001, 400, "permanent"],
    [190, 401, "config"],
    [131042, 402, "config"],
  ])("code %i (HTTP %i) is %s", async (code, status, kind) => {
    graph.respondNext(metaError(code, status));
    const error = await failure(client.sendText(sender, { to: "1", body: "x" }));
    expect(error).toMatchObject({
      kind,
      code,
      httpStatus: status,
      subcode: 2494055,
      details: "details here",
      fbtraceId: "Az8or2yhqkZfEZ",
    });
  });

  it("never puts the token in errors", async () => {
    graph.respondNext(metaError(190, 401));
    const error = await failure(client.sendText(sender, { to: "1", body: "x" }));
    expect(JSON.stringify(error.toJSON()) + error.message).not.toContain("EAAG");
  });

  it("treats a 2xx without a message id as unknown (never resend)", async () => {
    graph.respondNext({ status: 200, body: { messaging_product: "whatsapp" } });
    expect((await failure(client.sendText(sender, { to: "1", body: "x" }))).kind).toBe("unknown");
  });

  it("a refused connection never reached Meta, so it's transient", async () => {
    const closed = await startFakeGraph();
    await closed.close();
    const offline = createWhatsAppClient({ baseUrl: closed.url, graphVersion: "v24.0" });
    expect((await failure(offline.sendText(sender, { to: "1", body: "x" }))).kind).toBe(
      "transient",
    );
  });

  it("a timeout may have reached Meta, so it's unknown", async () => {
    const slow = createWhatsAppClient({ baseUrl: graph.url, graphVersion: "v24.0", timeoutMs: 1 });
    graph.respondNext({ status: 200, body: {} });
    expect((await failure(slow.sendText(sender, { to: "1", body: "x" }))).kind).toBe("unknown");
  });
});

describe("the fake Graph API (end-to-end tests)", () => {
  it("lists what it recorded over HTTP, for a test in another process", async () => {
    const fake = await startFakeGraph();
    const own = createWhatsAppClient({ baseUrl: fake.url, graphVersion: "v24.0" });
    await own.sendText(sender, { to: "573001112233", body: "hola" });
    const response = await fetch(`${fake.url}${FAKE_GRAPH_REQUESTS_PATH}`);
    const listed = (await response.json()) as { body: { to?: string } }[];
    expect(listed.map((r) => r.body.to)).toEqual(["573001112233"]);
    // Reading the list is not itself a Graph request.
    expect(fake.requests).toHaveLength(1);
    await fake.close();
  });
});
