import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { signWebhookBody } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import {
  createChannelResolver,
  createInboundQueue,
  createInboundWorker,
  echoResponder,
  enqueueInboundBatch,
  ingestWebhookEvents,
  processInboundBatch,
  type InboundJobData,
  type Queue,
  type Worker,
} from "@platform/core";
import { createCoreHarness, type CoreHarness } from "@platform/core/testing";
import { parseEnv, redisEnv } from "@platform/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "./app.ts";

const APP_SECRET = "test-app-secret-0123456789abcdef";
const VERIFY_TOKEN = "test-verify-token-0123456789";
// Wide enough that two back-to-back posts always land in one burst, even under load.
const DEBOUNCE_MS = 1_000;

let h: CoreHarness;
let queue: Queue<InboundJobData>;
let worker: Worker<InboundJobData>;
let app: App;

beforeAll(async () => {
  h = await createCoreHarness();
  const connection = { redisUrl: parseEnv(redisEnv).REDIS_URL, prefix: `test-${randomUUID()}` };
  queue = createInboundQueue(connection);
  worker = createInboundWorker(
    connection,
    (job) => processInboundBatch({ ...h.deps, responder: echoResponder }, job.data),
    {
      concurrency: 2,
    },
  );
  const resolveChannel = createChannelResolver(h.deps.db);
  app = buildApp({
    logger: h.deps.logger,
    meta: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
    ingest: (events) =>
      ingestWebhookEvents(
        {
          db: h.deps.db,
          logger: h.deps.logger,
          resolveChannel,
          enqueue: (d) => enqueueInboundBatch(queue, d, DEBOUNCE_MS),
        },
        events,
      ),
    health: { postgres: () => h.testDb.pool.query("SELECT 1"), redis: () => queue.count() },
  });
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await app.close();
  await h.close();
});

function post(body: string, signature = signWebhookBody(body, APP_SECRET)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    payload: body,
  });
}

/** Meta's recorded text-message webhook, from `from` with our own id and text. */
function textWebhook(from: string, id: string, text: string): string {
  return JSON.stringify(webhookFixture("text-message"))
    .replaceAll("16505551234", from)
    .replace(/"id":"wamid\.[^"]+"/, `"id":"${id}"`)
    .replace("Does it come in another color?", text)
    .replace(/"timestamp":"\d+"/, `"timestamp":"${String(Math.floor(Date.now() / 1000))}"`);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(50);
  }
}

const sentTo = (to: string) => h.graph.requests.filter((r) => r.body.to === to);

describe("GET /webhooks/whatsapp (subscription check)", () => {
  it("echoes the challenge for our verify token", async () => {
    const res = await app.inject({
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("1158201444");
    expect(JSON.stringify(h.logs)).not.toContain(VERIFY_TOKEN);
  });

  it("refuses a wrong token", async () => {
    const res = await app.inject({
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1",
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /webhooks/whatsapp", () => {
  it("refuses unsigned or tampered payloads and stores nothing", async () => {
    const body = textWebhook("573100000001", "wamid.unsigned", "Hola");
    expect((await post(body, "")).statusCode).toBe(401);
    expect(
      (await post(body.replace("Hola", "Adiós"), signWebhookBody(body, APP_SECRET))).statusCode,
    ).toBe(401);
    const rows = await h.testDb.pool.query(
      "SELECT 1 FROM messages WHERE wa_message_id = 'wamid.unsigned'",
    );
    expect(rows.rowCount).toBe(0);
  });

  it("M2 acceptance: Meta delivers a message twice → stored once, echoed once", async () => {
    const body = textWebhook("573100000002", "wamid.twice", "Hola, ¿tienen citas?");
    expect((await post(body)).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(200);

    await waitFor(() => sentTo("573100000002").length > 0);
    await sleep(DEBOUNCE_MS * 3);
    expect(sentTo("573100000002").map((r) => r.body.text)).toEqual([
      { body: "echo: Hola, ¿tienen citas?", preview_url: false },
    ]);

    const rows = await h.testDb.pool.query<{ direction: string; status: string }>(
      `SELECT m.direction, m.status FROM messages m JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_number = '573100000002' ORDER BY m.created_at`,
    );
    expect(rows.rows).toEqual([
      { direction: "inbound", status: "received" },
      { direction: "outbound", status: "sent" },
    ]);
  });

  it("answers a burst of messages once (debounce)", async () => {
    await post(textWebhook("573100000003", "wamid.burst-1", "Buenas"));
    await post(textWebhook("573100000003", "wamid.burst-2", "quiero agendar"));
    await waitFor(() => sentTo("573100000003").length > 0);
    await sleep(DEBOUNCE_MS * 3);
    expect(sentTo("573100000003").map((r) => (r.body.text as { body: string }).body)).toEqual([
      "echo: Buenas / quiero agendar",
    ]);
  });

  it("applies the delivery status Meta sends for our reply", async () => {
    const { rows } = await h.testDb.pool.query<{ wa_message_id: string }>(
      "SELECT wa_message_id FROM messages WHERE direction = 'outbound' AND status = 'sent' LIMIT 1",
    );
    const waMessageId = rows[0]?.wa_message_id ?? "";
    const status = JSON.stringify(webhookFixture("status-sent"))
      .replace(/"id":"wamid\.[^"]+"/, `"id":"${waMessageId}"`)
      .replace('"status":"sent"', '"status":"delivered"');
    expect((await post(status)).statusCode).toBe(200);
    const after = await h.testDb.pool.query(
      "SELECT status FROM messages WHERE wa_message_id = $1",
      [waMessageId],
    );
    expect(after.rows).toEqual([{ status: "delivered" }]);
  });

  it("acknowledges (200) numbers we don't serve, signed garbage, and other fields", async () => {
    const unknown = textWebhook("573100000004", "wamid.unknown", "Hola").replaceAll(
      "106540352242922",
      "777",
    );
    expect((await post(unknown)).statusCode).toBe(200);
    expect((await post("{not json")).statusCode).toBe(200);
    expect((await post(JSON.stringify({ object: "page", entry: [] }))).statusCode).toBe(200);
    const rows = await h.testDb.pool.query(
      "SELECT 1 FROM messages WHERE wa_message_id = 'wamid.unknown'",
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe("GET /health", () => {
  it("reports Postgres and Redis", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("answers 503 when a dependency is down", async () => {
    const broken = buildApp({
      logger: h.deps.logger,
      meta: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
      ingest: () => Promise.reject(new Error("unused")),
      health: {
        postgres: () => Promise.resolve(),
        redis: () => Promise.reject(new Error("ECONNREFUSED")),
      },
    });
    const res = await broken.inject({ url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "down", checks: { postgres: "ok", redis: "down" } });
    await broken.close();
  });
});
