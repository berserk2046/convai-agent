import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts,
  conversations,
  handoffs,
  messages,
  staffNotifications,
  type ContactRow,
  type ConversationRow,
  type HandoffRow,
  type MessageRow,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/** The staff inbox (spec §12). Tenant-scoped: run inside withTenant(). */

export interface InboxConversation {
  conversation: ConversationRow;
  contact: ContactRow;
  handoff: HandoffRow | null;
  lastMessage: Pick<MessageRow, "direction" | "type" | "body" | "createdAt"> | null;
}

/** Conversations with an open handoff first (longest waiting first), then the most recent. */
export async function listInboxConversations(
  db: Executor,
  businessId: string,
  options: { onlyHandoffs?: boolean; limit?: number } = {},
): Promise<InboxConversation[]> {
  const last = db
    .select({
      conversationId: messages.conversationId,
      direction: messages.direction,
      type: messages.type,
      body: messages.body,
      createdAt: messages.createdAt,
      rank: sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc)`.as(
        "rank",
      ),
    })
    .from(messages)
    .where(eq(messages.businessId, businessId))
    .as("last");
  const rows = await db
    .select({
      conversation: conversations,
      contact: contacts,
      handoff: handoffs,
      last: {
        direction: last.direction,
        type: last.type,
        body: last.body,
        createdAt: last.createdAt,
      },
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(
      handoffs,
      and(eq(handoffs.conversationId, conversations.id), isNull(handoffs.resolvedAt)),
    )
    .leftJoin(last, and(eq(last.conversationId, conversations.id), eq(last.rank, 1)))
    .where(
      and(
        eq(conversations.businessId, businessId),
        options.onlyHandoffs ? sql`${handoffs.id} is not null` : undefined,
      ),
    )
    .orderBy(
      sql`${handoffs.id} is null`,
      asc(handoffs.openedAt),
      sql`${last.createdAt} desc nulls last`,
    )
    .limit(options.limit ?? 100);
  return rows.map((r) => ({
    conversation: r.conversation,
    contact: r.contact,
    handoff: r.handoff,
    lastMessage: r.last?.createdAt ? (r.last as InboxConversation["lastMessage"]) : null,
  }));
}

/** The latest `limit` messages of a conversation, oldest first, failed ones included. */
export async function listThread(
  db: Executor,
  conversationId: string,
  limit = 100,
): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Decision A2: staff re-enable automatic messages for a contact who opted out. */
export async function optInContact(db: Executor, contactId: string): Promise<boolean> {
  const rows = await db
    .update(contacts)
    .set({ optedOutAt: null })
    .where(eq(contacts.id, contactId))
    .returning({ id: contacts.id });
  return rows.length === 1;
}

export async function countUnreadNotifications(db: Executor, businessId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffNotifications)
    .where(and(eq(staffNotifications.businessId, businessId), isNull(staffNotifications.readAt)));
  return row?.n ?? 0;
}

/** Marks notifications read: the given ones, or all of the business's when `ids` is null. */
export async function markNotificationsRead(
  db: Executor,
  businessId: string,
  ids: readonly string[] | null,
  at: Date,
): Promise<void> {
  if (ids?.length === 0) return;
  await db
    .update(staffNotifications)
    .set({ readAt: at })
    .where(
      and(
        eq(staffNotifications.businessId, businessId),
        isNull(staffNotifications.readAt),
        ids ? inArray(staffNotifications.id, [...ids]) : undefined,
      ),
    );
}
