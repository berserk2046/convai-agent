import { eq, sql } from "drizzle-orm";
import { contacts, conversations, type ContactRow, type ConversationRow } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/** The contact for a WhatsApp number, created on first contact. */
export async function upsertContact(
  db: Executor,
  businessId: string,
  waNumber: string,
): Promise<ContactRow> {
  const [row] = await db
    .insert(contacts)
    .values({ businessId, waNumber })
    // A no-op update so the existing row comes back from RETURNING.
    .onConflictDoUpdate({ target: [contacts.businessId, contacts.waNumber], set: { waNumber } })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}

/** The contact's single conversation (spec §6), created if missing. */
export async function ensureConversation(
  db: Executor,
  businessId: string,
  contactId: string,
): Promise<ConversationRow> {
  const [row] = await db
    .insert(conversations)
    .values({ businessId, contactId })
    .onConflictDoUpdate({ target: conversations.contactId, set: { contactId } })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}

export async function getConversation(
  db: Executor,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return row ?? null;
}

export async function getContact(db: Executor, contactId: string): Promise<ContactRow | null> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  return row ?? null;
}

/** Moves the customer service window forward; out-of-order deliveries never move it back. */
export async function recordInbound(db: Executor, conversationId: string, at: Date): Promise<void> {
  await db
    .update(conversations)
    .set({
      lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(conversations.id, conversationId));
}

export async function recordOutbound(
  db: Executor,
  conversationId: string,
  at: Date,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      lastOutboundAt: sql`greatest(${conversations.lastOutboundAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(conversations.id, conversationId));
}
