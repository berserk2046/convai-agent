import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SlotTakenError } from "../errors.ts";
import {
  bookings,
  type BusinessRow,
  type ContactRow,
  type ConversationRow,
  type ResourceRow,
} from "../schema/index.ts";
import { withTenant } from "../tenant.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import {
  claimEmergencyReply,
  consumeProposal,
  createProposal,
  getOpenHandoff,
  listOpenProposals,
  openHandoff,
  recordUsage,
  resolveHandoff,
  usageCostSince,
} from "./agent.ts";
import { ensureConversation, getConversation, upsertContact } from "./conversations.ts";
import { createTestBusiness } from "./fixtures.ts";
import {
  cancelBooking,
  completeDueBookings,
  createClosure,
  createResource,
  getContactBooking,
  insertBooking,
  listActiveBookings,
  listActiveResources,
  listClosures,
  listContactBookings,
  moveBooking,
  type NewBooking,
} from "./scheduling.ts";

let testDb: TestDatabase;
let business: BusinessRow;
let other: BusinessRow;
let chair1: ResourceRow;
let chair2: ResourceRow;
let contact: ContactRow;
let conversation: ConversationRow;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  testDb = await createTestDatabase();
  business = await createTestBusiness(testDb.db, "Clínica A");
  other = await createTestBusiness(testDb.db, "Clínica B");
  chair1 = await createResource(testDb.db, {
    businessId: business.id,
    kind: "chair",
    name: "Sillón 1",
  });
  chair2 = await createResource(testDb.db, {
    businessId: business.id,
    kind: "chair",
    name: "Sillón 2",
  });
  contact = await upsertContact(testDb.db, business.id, "573001112233");
  conversation = await ensureConversation(testDb.db, business.id, contact.id);
});

afterAll(async () => {
  await testDb.drop();
});

function booking(overrides: Partial<NewBooking> = {}): NewBooking {
  return {
    businessId: business.id,
    contactId: contact.id,
    resourceId: chair1.id,
    serviceKey: "limpieza",
    serviceName: "Limpieza dental",
    priceCop: 120000,
    subjectName: "Laura Gómez",
    partySize: null,
    startsAt: at("2026-10-08T15:00:00-05:00"),
    endsAt: at("2026-10-08T15:45:00-05:00"),
    source: "agent",
    notes: null,
    ...overrides,
  };
}

describe("bookings and the no-overlap constraint (principle 3)", () => {
  it("20 parallel bookings of one slot on one chair → exactly 1 succeeds", async () => {
    const slot = {
      startsAt: at("2026-10-09T09:00:00-05:00"),
      endsAt: at("2026-10-09T09:45:00-05:00"),
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        withTenant(testDb.db, business.id, (tx) => insertBooking(tx, booking(slot))),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const taken = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SlotTakenError,
    );
    expect(ok).toHaveLength(1);
    expect(taken).toHaveLength(19);
  });

  it("allows back-to-back bookings and the same time on another chair", async () => {
    await insertBooking(testDb.db, booking());
    await expect(
      insertBooking(
        testDb.db,
        booking({
          startsAt: at("2026-10-08T15:45:00-05:00"),
          endsAt: at("2026-10-08T16:30:00-05:00"),
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      insertBooking(testDb.db, booking({ resourceId: chair2.id })),
    ).resolves.toBeDefined();
    await expect(
      insertBooking(
        testDb.db,
        booking({
          startsAt: at("2026-10-08T15:30:00-05:00"),
          endsAt: at("2026-10-08T16:00:00-05:00"),
        }),
      ),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("frees the slot when a booking is cancelled", async () => {
    const slot = {
      startsAt: at("2026-10-12T10:00:00-05:00"),
      endsAt: at("2026-10-12T10:30:00-05:00"),
    };
    const first = await insertBooking(testDb.db, booking(slot));
    expect((await cancelBooking(testDb.db, first.id))?.status).toBe("cancelled");
    await expect(insertBooking(testDb.db, booking(slot))).resolves.toBeDefined();
  });

  it("moves a booking atomically, refusing an occupied slot", async () => {
    const original = await insertBooking(
      testDb.db,
      booking({
        startsAt: at("2026-10-13T08:00:00-05:00"),
        endsAt: at("2026-10-13T08:45:00-05:00"),
      }),
    );
    await insertBooking(
      testDb.db,
      booking({
        startsAt: at("2026-10-13T10:00:00-05:00"),
        endsAt: at("2026-10-13T10:45:00-05:00"),
      }),
    );
    await expect(
      moveBooking(testDb.db, original.id, {
        startsAt: at("2026-10-13T10:15:00-05:00"),
        endsAt: at("2026-10-13T11:00:00-05:00"),
        resourceId: chair1.id,
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    const moved = await moveBooking(testDb.db, original.id, {
      startsAt: at("2026-10-13T11:00:00-05:00"),
      endsAt: at("2026-10-13T11:45:00-05:00"),
      resourceId: chair1.id,
    });
    expect(moved).toMatchObject({
      startsAt: at("2026-10-13T11:00:00-05:00"),
      rescheduledAt: expect.any(Date),
    });
  });

  it("finds a contact's bookings and only theirs", async () => {
    const upcoming = await listContactBookings(testDb.db, contact.id, {
      from: at("2026-10-08T00:00:00-05:00"),
    });
    expect(upcoming.every((b) => b.status === "pending")).toBe(true);
    expect(upcoming.map((b) => b.startsAt.toISOString())).toEqual(
      [...upcoming.map((b) => b.startsAt.toISOString())].sort(),
    );
    const stranger = await upsertContact(testDb.db, business.id, "573009999999");
    expect(await getContactBooking(testDb.db, upcoming[0]?.id ?? "", stranger.id)).toBeNull();
  });

  it("lists busy bookings and closures overlapping a range", async () => {
    await createClosure(testDb.db, {
      businessId: business.id,
      startsAt: at("2026-10-12T00:00:00-05:00"),
      endsAt: at("2026-10-13T00:00:00-05:00"),
      reason: "Festivo",
    });
    const day = [at("2026-10-12T00:00:00-05:00"), at("2026-10-13T00:00:00-05:00")] as const;
    expect(await listClosures(testDb.db, business.id, ...day)).toHaveLength(1);
    expect(await listActiveBookings(testDb.db, business.id, [chair1.id], ...day)).toHaveLength(1);
    expect(await listActiveResources(testDb.db, business.id, "chair")).toHaveLength(2);
  });

  it("completes bookings an hour after they end, leaving no-shows alone", async () => {
    const past = await insertBooking(
      testDb.db,
      booking({
        startsAt: at("2026-10-01T09:00:00-05:00"),
        endsAt: at("2026-10-01T09:30:00-05:00"),
      }),
    );
    const noShow = await insertBooking(
      testDb.db,
      booking({
        startsAt: at("2026-10-01T10:00:00-05:00"),
        endsAt: at("2026-10-01T10:30:00-05:00"),
      }),
    );
    await testDb.pool.query("UPDATE bookings SET status = 'no_show' WHERE id = $1", [noShow.id]);

    const tooSoon = await completeDueBookings(testDb.db, at("2026-10-01T10:15:00-05:00"));
    expect(tooSoon.map((b) => b.id)).not.toContain(past.id);
    const done = await completeDueBookings(testDb.db, at("2026-10-01T12:00:00-05:00"));
    expect(done.map((b) => b.id)).toEqual([past.id]);
    expect(done[0]).toMatchObject({
      status: "completed",
      completedAt: at("2026-10-01T12:00:00-05:00"),
    });
  });

  it("is invisible to other tenants", async () => {
    const seen = await withTenant(testDb.db, other.id, (tx) => tx.select().from(bookings));
    expect(seen).toEqual([]);
  });
});

describe("proposals, handoffs and usage", () => {
  it("consumes a proposal only once", async () => {
    const proposal = await createProposal(testDb.db, {
      businessId: business.id,
      conversationId: conversation.id,
      action: "book",
      params: { service_key: "limpieza" },
      turnId: "turn-1",
      expiresAt: at("2026-10-08T18:00:00-05:00"),
    });
    expect(
      await listOpenProposals(testDb.db, conversation.id, at("2026-10-08T12:00:00-05:00")),
    ).toHaveLength(1);
    expect(
      await listOpenProposals(testDb.db, conversation.id, at("2026-10-08T19:00:00-05:00")),
    ).toHaveLength(0);
    expect(await consumeProposal(testDb.db, proposal.id)).toBe(true);
    expect(await consumeProposal(testDb.db, proposal.id)).toBe(false);
  });

  it("opens one handoff per conversation, silences the bot, and allows one emergency reply", async () => {
    const first = await openHandoff(testDb.db, {
      businessId: business.id,
      conversationId: conversation.id,
      reason: "urgencia",
      summary: "Cara hinchada",
    });
    const second = await openHandoff(testDb.db, {
      businessId: business.id,
      conversationId: conversation.id,
      reason: "queja",
      summary: null,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ handoff: first.handoff, created: false });
    expect((await getConversation(testDb.db, conversation.id))?.mode).toBe("human");
    expect(await claimEmergencyReply(testDb.db, first.handoff.id)).toBe(true);
    expect(await claimEmergencyReply(testDb.db, first.handoff.id)).toBe(false);

    await resolveHandoff(testDb.db, conversation.id, null);
    expect(await getOpenHandoff(testDb.db, conversation.id)).toBeNull();
    expect((await getConversation(testDb.db, conversation.id))?.mode).toBe("bot");
  });

  it("sums the month's LLM cost", async () => {
    await recordUsage(testDb.db, {
      businessId: business.id,
      kind: "llm",
      units: 4000,
      costUsd: 0.0123,
    });
    await recordUsage(testDb.db, {
      businessId: business.id,
      kind: "llm",
      units: 1000,
      costUsd: 0.001,
    });
    await recordUsage(testDb.db, { businessId: other.id, kind: "llm", units: 1000, costUsd: 5 });
    expect(
      await usageCostSince(testDb.db, business.id, "llm", at("2026-01-01T00:00:00Z")),
    ).toBeCloseTo(0.0133, 6);
  });
});
