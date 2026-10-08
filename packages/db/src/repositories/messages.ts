import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { messages, type MessageRow, type MessageStatus } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

export interface InboundMessageInput {
  businessId: string;
  conversationId: string;
  waMessageId: string;
  type: string;
  body: string | null;
  payload: Record<string, unknown>;
  waTimestamp: Date;
  /** True for messages the bot never answers (reactions, edits…): stored as already handled. */
  alreadyProcessed: boolean;
}

/** Stores an inbound message once. Returns null when Meta re-delivered one we already have. */
export async function insertInboundMessage(
  db: Executor,
  input: InboundMessageInput,
): Promise<MessageRow | null> {
  const [row] = await db
    .insert(messages)
    .values({
      businessId: input.businessId,
      conversationId: input.conversationId,
      direction: "inbound",
      type: input.type,
      body: input.body,
      payload: input.payload,
      waMessageId: input.waMessageId,
      status: "received",
      waTimestamp: input.waTimestamp,
      processedAt: input.alreadyProcessed ? sql`now()` : null,
    })
    .onConflictDoNothing({ target: messages.waMessageId })
    .returning();
  return row ?? null;
}

/** Inbound messages the worker hasn't handled yet, oldest first. */
export async function listUnprocessedInbound(
  db: Executor,
  conversationId: string,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
        isNull(messages.processedAt),
      ),
    )
    .orderBy(asc(messages.waTimestamp), asc(messages.createdAt));
}

/**
 * Marks inbound messages handled. Returns how many this call claimed; fewer than asked
 * means another run got there first, and the caller must not reply.
 */
export async function claimInbound(db: Executor, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(messages)
    .set({ processedAt: sql`now()` })
    .where(and(inArray(messages.id, [...ids]), isNull(messages.processedAt)))
    .returning({ id: messages.id });
  return rows.length;
}

export interface OutboundMessageInput {
  businessId: string;
  conversationId: string;
  /** "text" or "template". */
  type: string;
  body: string | null;
  payload?: Record<string, unknown>;
  /** Same key → same message: a retried job can never create a second copy. */
  idempotencyKey: string;
  /** How the reply was produced: model, tokens, cost, tool calls (spec §7.8). */
  meta?: {
    kind: string;
    model?: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd?: number;
    toolCalls?: unknown[];
  };
}

/** Records an outgoing message as pending. Returns null if the key was used already. */
export async function insertOutboundMessage(
  db: Executor,
  input: OutboundMessageInput,
): Promise<MessageRow | null> {
  const [row] = await db
    .insert(messages)
    .values({
      businessId: input.businessId,
      conversationId: input.conversationId,
      direction: "outbound",
      type: input.type,
      body: input.body,
      payload: {
        ...input.payload,
        ...(input.meta ? { kind: input.meta.kind, model: input.meta.model ?? null } : {}),
      },
      status: "pending",
      idempotencyKey: input.idempotencyKey,
      toolCalls: input.meta?.toolCalls ?? null,
      inputTokens: input.meta?.usage?.input ?? null,
      outputTokens: input.meta?.usage?.output ?? null,
      cacheReadTokens: input.meta?.usage?.cacheRead ?? null,
      cacheWriteTokens: input.meta?.usage?.cacheWrite ?? null,
      costUsd: input.meta?.costUsd === undefined ? null : input.meta.costUsd.toFixed(6),
    })
    .onConflictDoNothing({ target: [messages.businessId, messages.idempotencyKey] })
    .returning();
  return row ?? null;
}

/** Outgoing messages nobody has tried to send yet, oldest first. */
export async function listUnsentOutbound(
  db: Executor,
  conversationId: string,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "pending"),
        isNull(messages.sendAttemptedAt),
      ),
    )
    .orderBy(asc(messages.createdAt));
}

/**
 * Claims a pending message for sending, right before calling Meta. Only one caller wins.
 * From here on, a crash leaves the outcome unknown and the message is never resent.
 */
export async function markSendAttempted(db: Executor, messageId: string): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ sendAttemptedAt: sql`now()` })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.status, "pending"),
        isNull(messages.sendAttemptedAt),
      ),
    )
    .returning({ id: messages.id });
  return rows.length === 1;
}

/** Meta definitely didn't take it (transient error): allow another attempt. */
export async function releaseSendAttempt(db: Executor, messageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ sendAttemptedAt: null })
    .where(and(eq(messages.id, messageId), eq(messages.status, "pending")));
}

export async function markOutboundSent(
  db: Executor,
  messageId: string,
  result: { waMessageId: string; messageStatus: string | null },
): Promise<void> {
  await db
    .update(messages)
    .set({
      waMessageId: result.waMessageId,
      status: "sent",
      statusAt: sql`now()`,
      payload: sql`${messages.payload} || ${JSON.stringify({ meta_message_status: result.messageStatus })}::jsonb`,
    })
    // A status webhook can beat this update; never move a message backwards.
    .where(and(eq(messages.id, messageId), eq(messages.status, "pending")));
}

export async function markOutboundFailed(
  db: Executor,
  messageId: string,
  error: Record<string, unknown>,
): Promise<void> {
  await db
    .update(messages)
    .set({ status: "failed", statusAt: sql`now()`, error })
    .where(eq(messages.id, messageId));
}

/** Order of delivery statuses; a status update only applies if it moves forward. */
const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
  failed: 5,
};

export type DeliveryStatus = "sent" | "delivered" | "read" | "played" | "failed";

export function isDeliveryStatus(status: string): status is DeliveryStatus {
  return ["sent", "delivered", "read", "played", "failed"].includes(status);
}

export interface StatusUpdateInput {
  waMessageId: string;
  status: DeliveryStatus;
  at: Date;
  pricing: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

/**
 * Applies a status webhook to the outbound message it belongs to. Webhooks arrive out of
 * order (read before delivered), so older statuses are ignored. Returns the updated row,
 * or null if there was nothing to update.
 */
export async function applyStatusUpdate(
  db: Executor,
  input: StatusUpdateInput,
): Promise<MessageRow | null> {
  const cases = Object.entries(STATUS_RANK).map(
    ([status, rank]) => sql`when ${status} then ${rank}`,
  );
  const currentRank = sql`(case ${messages.status} ${sql.join(cases, sql` `)} end)`;
  const [row] = await db
    .update(messages)
    .set({
      status: input.status,
      statusAt: input.at,
      ...(input.pricing ? { pricing: input.pricing } : {}),
      ...(input.error ? { error: input.error } : {}),
    })
    .where(
      and(
        eq(messages.waMessageId, input.waMessageId),
        eq(messages.direction, "outbound"),
        sql`${currentRank} < ${STATUS_RANK[input.status]}`,
      ),
    )
    .returning();
  return row ?? null;
}
