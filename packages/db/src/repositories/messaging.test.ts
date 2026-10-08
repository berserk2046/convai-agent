import { randomBytes } from "node:crypto";
import { createSecretBox } from "@platform/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channels,
  contacts,
  messages,
  type BusinessRow,
  type ConversationRow,
} from "../schema/index.ts";
import { withTenant } from "../tenant.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import { channelAccessToken, createChannel, findActiveChannelByPhoneNumberId } from "./channels.ts";
import {
  ensureConversation,
  getConversation,
  recordInbound,
  upsertContact,
} from "./conversations.ts";
import { createTestBusiness } from "./fixtures.ts";
import {
  applyStatusUpdate,
  claimInbound,
  insertInboundMessage,
  insertOutboundMessage,
  listUnprocessedInbound,
  listUnsentOutbound,
  markOutboundSent,
  markSendAttempted,
} from "./messages.ts";

let testDb: TestDatabase;
let a: BusinessRow;
let b: BusinessRow;
const secrets = createSecretBox(randomBytes(32).toString("base64"));

beforeAll(async () => {
  testDb = await createTestDatabase();
  a = await createTestBusiness(testDb.db, "Clínica A");
  b = await createTestBusiness(testDb.db, "Clínica B");
});

afterAll(async () => {
  await testDb.drop();
});

describe("channels", () => {
  it("stores the token encrypted and finds the business by phone_number_id", async () => {
    await createChannel(testDb.db, secrets, {
      businessId: a.id,
      phoneNumberId: "106540352242922",
      wabaId: "102290129340398",
      displayPhone: "+57 300 000 0000",
      accessToken: "EAAG-real-token",
    });
    const raw = await testDb.pool.query<{ token_encrypted: string }>(
      "SELECT token_encrypted FROM channels",
    );
    expect(raw.rows[0]?.token_encrypted).not.toContain("EAAG");

    const channel = await findActiveChannelByPhoneNumberId(testDb.db, "106540352242922");
    expect(channel?.businessId).toBe(a.id);
    expect(channel && channelAccessToken(channel, secrets)).toBe("EAAG-real-token");
    expect(await findActiveChannelByPhoneNumberId(testDb.db, "999")).toBeNull();
  });

  it("allows one active channel per business and one business per number", async () => {
    const input = { wabaId: "1", displayPhone: "x", accessToken: "t" };
    await expect(
      createChannel(testDb.db, secrets, { ...input, businessId: a.id, phoneNumberId: "222" }),
    ).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    await expect(
      createChannel(testDb.db, secrets, {
        ...input,
        businessId: b.id,
        phoneNumberId: "106540352242922",
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("tenants read their channel but can't create one", async () => {
    const seen = await withTenant(testDb.db, b.id, (tx) => tx.select().from(channels));
    expect(seen).toEqual([]);
    await expect(
      withTenant(testDb.db, b.id, (tx) =>
        tx.insert(channels).values({
          businessId: b.id,
          phoneNumberId: "3",
          wabaId: "1",
          displayPhone: "x",
          tokenEncrypted: "x",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("contacts, conversations and messages", () => {
  let conversation: ConversationRow;

  beforeAll(async () => {
    conversation = await withTenant(testDb.db, a.id, async (tx) => {
      const contact = await upsertContact(tx, a.id, "573001234567");
      return ensureConversation(tx, a.id, contact.id);
    });
  });

  it("creates one contact and one conversation per number", async () => {
    const again = await withTenant(testDb.db, a.id, async (tx) => {
      const contact = await upsertContact(tx, a.id, "573001234567");
      return ensureConversation(tx, a.id, contact.id);
    });
    expect(again.id).toBe(conversation.id);
    expect(again.mode).toBe("bot");
  });

  it("stores an inbound message once, however often Meta delivers it", async () => {
    const input = {
      businessId: a.id,
      conversationId: conversation.id,
      waMessageId: "wamid.inbound-1",
      type: "text",
      body: "Hola",
      payload: {},
      waTimestamp: new Date("2026-10-05T14:00:00Z"),
      alreadyProcessed: false,
    };
    const first = await withTenant(testDb.db, a.id, (tx) => insertInboundMessage(tx, input));
    const second = await withTenant(testDb.db, a.id, (tx) => insertInboundMessage(tx, input));
    expect(first?.status).toBe("received");
    expect(second).toBeNull();
  });

  it("keeps the service window at the latest inbound time", async () => {
    await withTenant(testDb.db, a.id, async (tx) => {
      await recordInbound(tx, conversation.id, new Date("2026-10-05T14:00:00Z"));
      await recordInbound(tx, conversation.id, new Date("2026-10-05T13:00:00Z"));
    });
    const row = await withTenant(testDb.db, a.id, (tx) => getConversation(tx, conversation.id));
    expect(row?.lastInboundAt).toEqual(new Date("2026-10-05T14:00:00Z"));
  });

  it("lets only one run claim a batch", async () => {
    const pending = await withTenant(testDb.db, a.id, (tx) =>
      listUnprocessedInbound(tx, conversation.id),
    );
    const ids = pending.map((m) => m.id);
    expect(ids).toHaveLength(1);
    expect(await withTenant(testDb.db, a.id, (tx) => claimInbound(tx, ids))).toBe(1);
    expect(await withTenant(testDb.db, a.id, (tx) => claimInbound(tx, ids))).toBe(0);
    expect(
      await withTenant(testDb.db, a.id, (tx) => listUnprocessedInbound(tx, conversation.id)),
    ).toEqual([]);
  });

  it("creates an outbound message once per idempotency key, sendable once", async () => {
    const input = {
      businessId: a.id,
      conversationId: conversation.id,
      type: "text",
      body: "echo",
      idempotencyKey: "reply:x:0",
    };
    const row = await withTenant(testDb.db, a.id, (tx) => insertOutboundMessage(tx, input));
    expect(await withTenant(testDb.db, a.id, (tx) => insertOutboundMessage(tx, input))).toBeNull();
    if (!row) throw new Error("expected a row");

    expect(
      await withTenant(testDb.db, a.id, (tx) => listUnsentOutbound(tx, conversation.id)),
    ).toHaveLength(1);
    expect(await withTenant(testDb.db, a.id, (tx) => markSendAttempted(tx, row.id))).toBe(true);
    expect(await withTenant(testDb.db, a.id, (tx) => markSendAttempted(tx, row.id))).toBe(false);
    expect(
      await withTenant(testDb.db, a.id, (tx) => listUnsentOutbound(tx, conversation.id)),
    ).toEqual([]);

    await withTenant(testDb.db, a.id, (tx) =>
      markOutboundSent(tx, row.id, { waMessageId: "wamid.out-1", messageStatus: "accepted" }),
    );
    const [sent] = await testDb.db.select().from(messages).where(eq(messages.id, row.id));
    expect(sent).toMatchObject({
      status: "sent",
      waMessageId: "wamid.out-1",
      payload: { meta_message_status: "accepted" },
    });
  });

  it("applies status webhooks forward only", async () => {
    const update = (status: "delivered" | "read" | "failed", minute: number) =>
      withTenant(testDb.db, a.id, (tx) =>
        applyStatusUpdate(tx, {
          waMessageId: "wamid.out-1",
          status,
          at: new Date(`2026-10-05T14:${String(minute).padStart(2, "0")}:00Z`),
          pricing: { billable: true, category: "service" },
          error: null,
        }),
      );
    expect((await update("read", 2))?.status).toBe("read");
    expect(await update("delivered", 1)).toBeNull();
    const [row] = await testDb.db
      .select()
      .from(messages)
      .where(eq(messages.waMessageId, "wamid.out-1"));
    expect(row).toMatchObject({ status: "read", pricing: { billable: true, category: "service" } });
  });

  it("keeps each tenant's messages and contacts to itself", async () => {
    const seen = await withTenant(testDb.db, b.id, async (tx) => ({
      contacts: await tx.select().from(contacts),
      messages: await tx.select().from(messages),
      update: await applyStatusUpdate(tx, {
        waMessageId: "wamid.out-1",
        status: "failed",
        at: new Date(),
        pricing: null,
        error: null,
      }),
    }));
    expect(seen).toEqual({ contacts: [], messages: [], update: null });
    const count = await testDb.db.execute(sql`select count(*)::int as n from messages`);
    expect(count.rows[0]).toEqual({ n: 2 });
  });

  it("keeps the order of replies written in one transaction", async () => {
    const bodies = ["consent", "answer", "handoff"];
    await withTenant(testDb.db, a.id, async (tx) => {
      for (const [i, body] of bodies.entries()) {
        await insertOutboundMessage(tx, {
          businessId: a.id,
          conversationId: conversation.id,
          type: "text",
          body,
          idempotencyKey: `reply:order:${String(i)}`,
        });
      }
    });
    const unsent = await withTenant(testDb.db, a.id, (tx) =>
      listUnsentOutbound(tx, conversation.id),
    );
    expect(unsent.map((m) => m.body)).toEqual(bodies);
    // Distinct in Postgres (microseconds), not only by the order rows happen to come back in.
    const distinct = await testDb.db.execute(
      sql`select count(distinct created_at)::int as n from messages where idempotency_key like 'reply:order:%'`,
    );
    expect(distinct.rows[0]).toEqual({ n: 3 });
  });
});
