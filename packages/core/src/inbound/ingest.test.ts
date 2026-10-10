import { parseWebhook, type WebhookEvent } from "@platform/channels";
import { webhookFixture, type FixtureName } from "@platform/channels/testing";
import { conversations, messages } from "@platform/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCoreHarness, type CoreHarness } from "../testing.ts";
import { createChannelResolver, ingestWebhookEvents, type IngestDeps } from "./ingest.ts";
import type { InboundJobData } from "./queue.ts";

let h: CoreHarness;
let enqueued: (InboundJobData & { waNumber: string })[];
let deps: IngestDeps;

beforeAll(async () => {
  h = await createCoreHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  enqueued = [];
  deps = {
    db: h.deps.db,
    logger: h.deps.logger,
    resolveChannel: createChannelResolver(h.deps.db),
    enqueue: (data) => {
      enqueued.push(data);
      return Promise.resolve();
    },
  };
});

/** A recorded payload, optionally with its wamid replaced (several fixtures share one). */
function events(name: FixtureName, waMessageId?: string): WebhookEvent[] {
  let json = JSON.stringify(webhookFixture(name));
  if (waMessageId) json = json.replace(/"id":"wamid\.[^"]+"/, `"id":"${waMessageId}"`);
  const parsed = parseWebhook(JSON.parse(json));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.events;
}

describe("ingestWebhookEvents", () => {
  it("stores a text message, opens the service window and enqueues a batch", async () => {
    const summary = await ingestWebhookEvents(deps, events("text-message"));
    expect(summary).toEqual({
      stored: 1,
      duplicates: 0,
      statuses: 0,
      templateUpdates: 0,
      unknownPhoneNumberIds: [],
    });

    const [message] = await h.testDb.db.select().from(messages);
    expect(message).toMatchObject({
      businessId: h.business.id,
      direction: "inbound",
      type: "text",
      body: "Does it come in another color?",
      status: "received",
      processedAt: null,
      waTimestamp: new Date(1749416383 * 1000),
    });
    const [conversation] = await h.testDb.db.select().from(conversations);
    expect(conversation?.lastInboundAt).toEqual(new Date(1749416383 * 1000));
    expect(enqueued).toEqual([
      { businessId: h.business.id, conversationId: conversation?.id, waNumber: "16505551234" },
    ]);
  });

  it("ignores Meta re-delivering the same message", async () => {
    const summary = await ingestWebhookEvents(deps, events("text-message"));
    expect(summary).toMatchObject({ stored: 0, duplicates: 1 });
    expect(enqueued).toEqual([]);
  });

  it("never stores the WhatsApp profile name before consent", async () => {
    const rows = await h.testDb.pool.query("SELECT payload::text AS p FROM messages");
    expect(rows.rows.map((r: { p: string }) => r.p).join()).not.toContain("Sheena Nelson");
  });

  it("stores reactions and edits as handled, without waking the worker", async () => {
    await ingestWebhookEvents(deps, [
      ...events("reaction-message", "wamid.reaction"),
      ...events("unsupported-message", "wamid.edit"),
    ]);
    const rows = await h.testDb.pool.query<{ type: string; handled: boolean }>(
      "SELECT type, processed_at IS NOT NULL AS handled FROM messages WHERE type IN ('reaction', 'unsupported') ORDER BY type",
    );
    expect(rows.rows).toEqual([
      { type: "reaction", handled: true },
      { type: "unsupported", handled: true },
    ]);
    expect(enqueued).toEqual([]);
  });

  it("acknowledges numbers with no channel without storing anything, and alerts", async () => {
    const payload = JSON.stringify(webhookFixture("text-message")).replaceAll(
      "106540352242922",
      "999999",
    );
    const parsed = parseWebhook(JSON.parse(payload));
    if (!parsed.ok) throw new Error(parsed.error);
    const summary = await ingestWebhookEvents(deps, parsed.events);
    expect(summary).toEqual({
      stored: 0,
      duplicates: 0,
      statuses: 0,
      templateUpdates: 0,
      unknownPhoneNumberIds: ["999999"],
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({ alert: "wa_unknown_phone_number", phone_number_ids: ["999999"] }),
    );
  });

  it("applies delivery statuses to our outbound messages and alerts on failures", async () => {
    const [conversation] = await h.testDb.db.select().from(conversations);
    if (!conversation) throw new Error("no conversation");
    await h.testDb.db.insert(messages).values([
      {
        businessId: h.business.id,
        conversationId: conversation.id,
        direction: "outbound",
        type: "text",
        status: "pending",
        waMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
      },
      {
        businessId: h.business.id,
        conversationId: conversation.id,
        direction: "outbound",
        type: "template",
        status: "sent",
        waMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA",
      },
    ]);

    const summary = await ingestWebhookEvents(deps, [
      ...events("status-sent"),
      ...events("status-failed"),
    ]);
    expect(summary.statuses).toBe(2);
    const rows = await h.testDb.pool.query<{ status: string; pricing: unknown; error: unknown }>(
      "SELECT status, pricing, error FROM messages WHERE direction = 'outbound' ORDER BY type DESC",
    );
    expect(rows.rows).toEqual([
      {
        status: "sent",
        pricing: { billable: true, model: "PMP", type: "regular", category: "marketing" },
        error: null,
      },
      {
        status: "failed",
        pricing: null,
        error: expect.objectContaining({ kind: "delivery", code: 131049 }),
      },
    ]);
    expect(h.logs).toContainEqual(expect.objectContaining({ alert: "wa_delivery_failed" }));
  });

  it("charges a delivered message once, at Meta's rate for its category (ADR 0012)", async () => {
    const [conversation] = await h.testDb.db.select().from(conversations);
    if (!conversation) throw new Error("no conversation");
    const wamid = "wamid.CHARGE-TEST-0001";
    await h.testDb.db.insert(messages).values({
      businessId: h.business.id,
      conversationId: conversation.id,
      direction: "outbound",
      type: "template",
      status: "sent",
      waMessageId: wamid,
    });
    const statusEvent = (status: string, type = "regular") => {
      const json = JSON.stringify(webhookFixture("status-sent"))
        .replace(/"id":"wamid\.[^"]+"/, `"id":"${wamid}"`)
        .replace('"status":"sent"', `"status":"${status}"`)
        .replace('"type":"regular"', `"type":"${type}"`)
        .replace('"recipient_id":"16505551234"', '"recipient_id":"573001234567"');
      const parsed = parseWebhook(JSON.parse(json));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.events;
    };
    const charges = () =>
      h.testDb.pool.query<{ kind: string; cost_usd: string; details: unknown }>(
        "SELECT kind, cost_usd, details FROM usage_events WHERE message_id IS NOT NULL",
      );

    await ingestWebhookEvents(deps, statusEvent("sent"));
    expect((await charges()).rows).toEqual([]); // Meta charges on delivery
    await ingestWebhookEvents(deps, statusEvent("read"));
    await ingestWebhookEvents(deps, statusEvent("delivered")); // late: no update, no second charge
    await ingestWebhookEvents(deps, statusEvent("read"));
    expect((await charges()).rows).toEqual([
      {
        kind: "wa_marketing",
        cost_usd: "0.012500",
        details: { category: "marketing", market: "CO" },
      },
    ]);
  });

  it("doesn't charge free deliveries", async () => {
    const before = await h.testDb.pool.query("SELECT count(*)::int AS n FROM usage_events");
    const json = JSON.stringify(webhookFixture("status-sent"))
      .replace('"status":"sent"', '"status":"delivered"')
      .replace('"type":"regular"', '"type":"free_customer_service"');
    const parsed = parseWebhook(JSON.parse(json));
    if (!parsed.ok) throw new Error(parsed.error);
    await ingestWebhookEvents(deps, parsed.events);
    const after = await h.testDb.pool.query("SELECT count(*)::int AS n FROM usage_events");
    expect(after.rows).toEqual(before.rows);
  });
});
