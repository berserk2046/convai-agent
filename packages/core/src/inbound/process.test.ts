import { parseWebhook } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import {
  conversations,
  insertOutboundMessage,
  markSendAttempted,
  messages,
  withTenant,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WindowClosedError, sendTemplate, sendText } from "../outbound.ts";
import { createCoreHarness, type CoreHarness } from "../testing.ts";
import { createChannelResolver, ingestWebhookEvents } from "./ingest.ts";
import { processInboundBatch, type Responder } from "./process.ts";
import type { InboundJobData } from "./queue.ts";
import { echoResponder } from "./responders.ts";

let h: CoreHarness;
let counter = 0;

beforeAll(async () => {
  h = await createCoreHarness();
});

afterAll(async () => {
  await h.close();
});

/** Ingests a text from `from` (Meta's recorded payload with our values) and returns its job. */
async function receive(from: string, text: string): Promise<InboundJobData> {
  counter += 1;
  const payload = webhookFixture("text-message");
  const json = JSON.stringify(payload)
    .replaceAll("16505551234", from)
    .replace("Does it come in another color?", text)
    .replace(/"id":"wamid\.[^"]+"/, `"id":"wamid.in-${String(counter)}"`)
    .replace(/"timestamp":"\d+"/, `"timestamp":"${String(Math.floor(Date.now() / 1000))}"`);
  const parsed = parseWebhook(JSON.parse(json));
  if (!parsed.ok) throw new Error(parsed.error);
  const jobs: InboundJobData[] = [];
  await ingestWebhookEvents(
    {
      db: h.deps.db,
      logger: h.deps.logger,
      resolveChannel: createChannelResolver(h.deps.db),
      enqueue: (data) => {
        jobs.push({ businessId: data.businessId, conversationId: data.conversationId });
        return Promise.resolve();
      },
    },
    parsed.events,
  );
  const [job] = jobs;
  if (!job) throw new Error("nothing enqueued");
  return job;
}

const echo = { responder: echoResponder };
const sentTo = (to: string) => h.graph.requests.filter((r) => r.body.to === to);

describe("processInboundBatch", () => {
  it("answers a message once (the M2 echo), even if the job runs twice", async () => {
    const job = await receive("573000000001", "Hola");
    expect(await processInboundBatch({ ...h.deps, ...echo }, job)).toEqual({
      status: "handled",
      messages: 1,
      replies: 1,
    });
    expect(await processInboundBatch({ ...h.deps, ...echo }, job)).toEqual({ status: "empty" });

    expect(sentTo("573000000001").map((r) => r.body.text)).toEqual([
      { body: "echo: Hola", preview_url: false },
    ]);
    const [reply] = await h.testDb.db
      .select()
      .from(messages)
      .where(eq(messages.idempotencyKey, `reply:${await lastInboundId(job)}:0`));
    expect(reply).toMatchObject({
      direction: "outbound",
      status: "sent",
      waMessageId: expect.stringMatching(/^wamid\.FAKE/),
    });
  });

  it("answers a burst with one reply", async () => {
    await receive("573000000002", "Buenas");
    const job = await receive("573000000002", "quiero una cita");
    await processInboundBatch({ ...h.deps, ...echo }, job);
    expect(sentTo("573000000002").map((r) => r.body.text)).toEqual([
      { body: "echo: Buenas / quiero una cita", preview_url: false },
    ]);
  });

  it("stays silent while a person handles the conversation (principle 7)", async () => {
    const job = await receive("573000000003", "¿Hola?");
    await h.testDb.db
      .update(conversations)
      .set({ mode: "human" })
      .where(eq(conversations.id, job.conversationId));
    expect(await processInboundBatch({ ...h.deps, ...echo }, job)).toEqual({
      status: "handled",
      messages: 1,
      replies: 0,
    });
    expect(sentTo("573000000003")).toEqual([]);
  });

  it("does nothing when another run already claimed the batch", async () => {
    const job = await receive("573000000004", "Hola");
    // The responder is where a concurrent run would overtake us (the LLM call, from M3 on).
    const racing: Responder = async (batch, info) => {
      await processInboundBatch({ ...h.deps, ...echo }, job);
      return echoResponder(batch, info);
    };
    expect(await processInboundBatch({ ...h.deps, responder: racing }, job)).toEqual({
      status: "claimed_elsewhere",
    });
    expect(sentTo("573000000004")).toHaveLength(1);
  });

  it("retries after a transient error and still sends exactly once", async () => {
    const job = await receive("573000000005", "Hola");
    h.graph.respondNext({
      status: 429,
      body: { error: { message: "(#130429) Rate limit hit", code: 130429 } },
    });
    await expect(processInboundBatch({ ...h.deps, ...echo }, job)).rejects.toMatchObject({
      kind: "transient",
    });
    // BullMQ retries the job: the pending reply goes out, and the batch isn't answered twice.
    expect(await processInboundBatch({ ...h.deps, ...echo }, job)).toEqual({ status: "empty" });
    const accepted = h.graph.requests.filter((r) => r.body.to === "573000000005");
    expect(accepted).toHaveLength(2);
    const replies = await h.testDb.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, job.conversationId));
    expect(replies.filter((m) => m.direction === "outbound").map((m) => m.status)).toEqual([
      "sent",
    ]);
  });

  it("never resends when the outcome is unknown, and alerts", async () => {
    const job = await receive("573000000006", "Hola");
    h.graph.respondNext({ status: 200, body: {} });
    expect(await processInboundBatch({ ...h.deps, ...echo }, job)).toMatchObject({
      status: "handled",
    });
    await processInboundBatch({ ...h.deps, ...echo }, job);
    expect(sentTo("573000000006")).toHaveLength(1);
    const [reply] = (
      await h.testDb.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, job.conversationId))
    ).filter((m) => m.direction === "outbound");
    expect(reply).toMatchObject({ status: "failed", error: { kind: "unknown" } });
    expect(h.logs).toContainEqual(expect.objectContaining({ alert: "wa_send_unknown" }));
  });

  it("leaves a message alone if a crashed run had already started sending it", async () => {
    const job = await receive("573000000007", "Hola");
    const pending = await withTenant(h.deps.db, job.businessId, (tx) =>
      insertOutboundMessage(tx, {
        businessId: job.businessId,
        conversationId: job.conversationId,
        type: "text",
        body: "x",
        idempotencyKey: "crash:1",
      }),
    );
    if (!pending) throw new Error("no row");
    await withTenant(h.deps.db, job.businessId, (tx) => markSendAttempted(tx, pending.id));
    await processInboundBatch({ ...h.deps, ...echo }, job);
    expect(sentTo("573000000007").map((r) => r.body.text)).toEqual([
      { body: "echo: Hola", preview_url: false },
    ]);
  });
});

describe("sendText and sendTemplate", () => {
  it("refuses free-form text outside the 24-hour window", async () => {
    const job = await receive("573000000008", "Hola");
    const later = { ...h.deps, now: () => new Date(Date.now() + 25 * 3600 * 1000) };
    await expect(
      sendText(later, {
        businessId: job.businessId,
        conversationId: job.conversationId,
        body: "¿Sigue ahí?",
        idempotencyKey: "late:1",
      }),
    ).rejects.toBeInstanceOf(WindowClosedError);
    await sendText(h.deps, {
      businessId: job.businessId,
      conversationId: job.conversationId,
      body: "¿Sigue ahí?",
      idempotencyKey: "now:1",
    });
    expect(sentTo("573000000008").map((r) => r.body.type)).toEqual(["text"]);
  });

  it("sends templates with parameters and button payloads, once per key", async () => {
    const job = await receive("573000000009", "Hola");
    const input = {
      businessId: job.businessId,
      conversationId: job.conversationId,
      idempotencyKey: "recordatorio_24h:run-1",
      preview: "Hola Laura, le recordamos su cita…",
      template: {
        name: "recordatorio_cita_v1",
        languageCode: "es",
        bodyParameters: ["Laura"],
        quickReplyPayloads: ["recordatorio_24h:run-1:confirm"],
      },
    };
    await sendTemplate(h.deps, input);
    await sendTemplate(h.deps, input);
    const sent = sentTo("573000000009");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.template).toMatchObject({
      name: "recordatorio_cita_v1",
      language: { code: "es" },
    });
  });
});

async function lastInboundId(job: InboundJobData): Promise<string> {
  const rows = await h.testDb.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, job.conversationId));
  const inbound = rows.filter((m) => m.direction === "inbound");
  return inbound.at(-1)?.id ?? "";
}
