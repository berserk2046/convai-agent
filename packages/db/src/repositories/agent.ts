import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import {
  bookingProposals,
  contacts,
  conversations,
  handoffs,
  messages,
  usageEvents,
  type BookingProposalRow,
  type ContactRow,
  type HandoffRow,
  type MessageRow,
  type UsageKind,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

// --- contacts -----------------------------------------------------------------------------

export async function markConsentRequested(
  db: Executor,
  contactId: string,
  at: Date,
): Promise<void> {
  await db.update(contacts).set({ consentRequestedAt: at }).where(eq(contacts.id, contactId));
}

export async function grantConsent(
  db: Executor,
  contactId: string,
  source: "whatsapp" | "staff",
  at: Date,
): Promise<void> {
  await db
    .update(contacts)
    .set({ consentAt: at, consentSource: source })
    .where(and(eq(contacts.id, contactId), isNull(contacts.consentAt)));
}

export async function optOutContact(db: Executor, contactId: string, at: Date): Promise<void> {
  await db
    .update(contacts)
    .set({ optedOutAt: at })
    .where(and(eq(contacts.id, contactId), isNull(contacts.optedOutAt)));
}

/** Sets the contact's name only if it has none yet (decision A10). */
export async function setContactNameIfMissing(
  db: Executor,
  contactId: string,
  name: string,
): Promise<void> {
  await db
    .update(contacts)
    .set({ name })
    .where(and(eq(contacts.id, contactId), isNull(contacts.name)));
}

/** WhatsApp profile name, for staff only; callers store it only after consent (A10). */
export async function setWaProfileName(
  db: Executor,
  contactId: string,
  profileName: string,
): Promise<void> {
  await db.update(contacts).set({ waProfileName: profileName }).where(eq(contacts.id, contactId));
}

/** Replaces contact fields (already validated against the template's contact_fields). */
export async function setContactFields(
  db: Executor,
  contactId: string,
  fields: Record<string, unknown>,
): Promise<ContactRow | null> {
  const [row] = await db
    .update(contacts)
    .set({ fields })
    .where(eq(contacts.id, contactId))
    .returning();
  return row ?? null;
}

// --- conversations and history -------------------------------------------------------------

export async function setConversationMode(
  db: Executor,
  conversationId: string,
  mode: "bot" | "human",
): Promise<void> {
  await db.update(conversations).set({ mode }).where(eq(conversations.id, conversationId));
}

/** The latest `limit` messages, oldest first, excluding ones that never went out. */
export async function listRecentMessages(
  db: Executor,
  conversationId: string,
  limit: number,
): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), sql`${messages.status} <> 'failed'`))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

// --- booking proposals (decision A5) --------------------------------------------------------

export async function createProposal(
  db: Executor,
  input: {
    businessId: string;
    conversationId: string;
    action: "book" | "reschedule" | "cancel";
    params: Record<string, unknown>;
    turnId: string;
    expiresAt: Date;
  },
): Promise<BookingProposalRow> {
  const [row] = await db.insert(bookingProposals).values(input).returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** Unconsumed, unexpired proposals of a conversation, newest first. */
export async function listOpenProposals(
  db: Executor,
  conversationId: string,
  now: Date,
): Promise<BookingProposalRow[]> {
  return db
    .select()
    .from(bookingProposals)
    .where(
      and(
        eq(bookingProposals.conversationId, conversationId),
        isNull(bookingProposals.consumedAt),
        gt(bookingProposals.expiresAt, now),
      ),
    )
    .orderBy(desc(bookingProposals.createdAt));
}

/** Marks a proposal used; false if someone else used it first (no double execution). */
export async function consumeProposal(db: Executor, proposalId: string): Promise<boolean> {
  const rows = await db
    .update(bookingProposals)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(bookingProposals.id, proposalId), isNull(bookingProposals.consumedAt)))
    .returning({ id: bookingProposals.id });
  return rows.length === 1;
}

// --- handoffs (principle 7) -------------------------------------------------------------------

/**
 * Opens a handoff and puts the conversation in human mode. If one is already open, it is
 * returned unchanged (one open handoff per conversation).
 */
export async function openHandoff(
  db: Executor,
  input: { businessId: string; conversationId: string; reason: string; summary: string | null },
): Promise<{ handoff: HandoffRow; created: boolean }> {
  const [created] = await db
    .insert(handoffs)
    .values(input)
    .onConflictDoNothing({
      target: handoffs.conversationId,
      where: sql`${handoffs.resolvedAt} is null`,
    })
    .returning();
  await setConversationMode(db, input.conversationId, "human");
  if (created) return { handoff: created, created: true };
  const existing = await getOpenHandoff(db, input.conversationId);
  if (!existing) throw new Error("handoff conflict without an open handoff");
  return { handoff: existing, created: false };
}

export async function getOpenHandoff(
  db: Executor,
  conversationId: string,
): Promise<HandoffRow | null> {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));
  return row ?? null;
}

/** Decision A3: an emergency during an open handoff escalates it. */
export async function setHandoffReason(
  db: Executor,
  handoffId: string,
  reason: string,
): Promise<void> {
  await db.update(handoffs).set({ reason }).where(eq(handoffs.id, handoffId));
}

/** Decision A3: true only the first time per open handoff. */
export async function claimEmergencyReply(db: Executor, handoffId: string): Promise<boolean> {
  const rows = await db
    .update(handoffs)
    .set({ emergencyRepliedAt: sql`now()` })
    .where(and(eq(handoffs.id, handoffId), isNull(handoffs.emergencyRepliedAt)))
    .returning({ id: handoffs.id });
  return rows.length === 1;
}

/** Closes the open handoff and gives the conversation back to the bot (M5 inbox). */
export async function resolveHandoff(
  db: Executor,
  conversationId: string,
  resolvedBy: string | null,
): Promise<void> {
  await db
    .update(handoffs)
    .set({ resolvedAt: sql`now()`, resolvedBy })
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));
  await setConversationMode(db, conversationId, "bot");
}

// --- usage and budgets (principle 10) ------------------------------------------------------------

export async function recordUsage(
  db: Executor,
  input: {
    businessId: string;
    kind: UsageKind;
    units: number;
    costUsd: number;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(usageEvents).values({
    businessId: input.businessId,
    kind: input.kind,
    units: input.units,
    costUsd: input.costUsd.toFixed(6),
    details: input.details ?? {},
  });
}

/** Total cost of a usage kind since `from` (the start of the business's month). */
export async function usageCostSince(
  db: Executor,
  businessId: string,
  kind: UsageKind,
  from: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.businessId, businessId),
        eq(usageEvents.kind, kind),
        gte(usageEvents.at, from),
      ),
    );
  return Number(row?.total ?? 0);
}
