import {
  claimInbound,
  getContact,
  getConversation,
  insertOutboundMessage,
  listUnprocessedInbound,
  withTenant,
  type ContactRow,
  type ConversationRow,
  type MessageRow,
} from "@platform/db";
import type { CoreDeps } from "../deps.ts";
import { deliverPending } from "../outbound.ts";
import type { InboundJobData } from "./queue.ts";

/**
 * Handles one debounced batch: everything the contact sent that hasn't been handled yet.
 * In M2 a Responder produces the replies (echo for testing); M3 plugs in the agent.
 */

export interface InboundBatch {
  businessId: string;
  conversation: ConversationRow;
  contact: ContactRow;
  /** Oldest first. */
  messages: MessageRow[];
}

/** One outgoing reply, with what it cost to produce (for messages and usage reports). */
export interface Reply {
  body: string;
  meta?: {
    /** "agent" (model-written), "fixed" (template text) or "echo" (M2 harness). */
    kind: "agent" | "fixed" | "echo";
    model?: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd?: number;
    toolCalls?: unknown[];
  };
}

export interface ResponderInfo {
  /** The job won't be retried after this attempt: hand off instead of throwing. */
  finalAttempt: boolean;
}

/**
 * Turns a batch into replies. Runs before the batch is claimed, so it may be retried;
 * side effects it commits (bookings, consent) must be idempotent. Responders own
 * principle 7: while a person handles the conversation, they stay silent.
 */
export type Responder = (batch: InboundBatch, info: ResponderInfo) => Promise<Reply[]>;

export type BatchOutcome =
  | { status: "empty" }
  | { status: "claimed_elsewhere" }
  | { status: "handled"; messages: number; replies: number };

export async function processInboundBatch(
  deps: CoreDeps & { responder: Responder },
  job: InboundJobData,
  info: ResponderInfo = { finalAttempt: true },
): Promise<BatchOutcome> {
  const { businessId, conversationId } = job;
  // Finish anything a previous attempt queued but didn't get to send.
  await deliverPending(deps, businessId, conversationId);

  const batch = await withTenant(deps.db, businessId, async (tx) => {
    const conversation = await getConversation(tx, conversationId);
    const contact = conversation ? await getContact(tx, conversation.contactId) : null;
    const messages = await listUnprocessedInbound(tx, conversationId);
    return conversation && contact ? { businessId, conversation, contact, messages } : null;
  });
  if (!batch || batch.messages.length === 0) return { status: "empty" };

  const replies = await deps.responder(batch, info);

  const ids = batch.messages.map((m) => m.id);
  const lastId = ids.at(-1);
  const claimed = await withTenant(deps.db, businessId, async (tx) => {
    if ((await claimInbound(tx, ids)) !== ids.length) {
      // Another run handled (part of) this batch: throwing undoes our claims; stay quiet.
      throw new ClaimedElsewhere();
    }
    for (const [i, reply] of replies.entries()) {
      await insertOutboundMessage(tx, {
        businessId,
        conversationId,
        type: "text",
        body: reply.body,
        idempotencyKey: `reply:${lastId ?? ""}:${i}`,
        ...(reply.meta ? { meta: reply.meta } : {}),
      });
    }
    return true;
  }).catch((error: unknown) => {
    if (error instanceof ClaimedElsewhere) return false;
    throw error;
  });
  if (!claimed) return { status: "claimed_elsewhere" };

  deps.logger.info(
    {
      business_id: businessId,
      conversation_id: conversationId,
      messages: ids.length,
      replies: replies.length,
    },
    "inbound batch handled",
  );
  await deliverPending(deps, businessId, conversationId);
  return { status: "handled", messages: ids.length, replies: replies.length };
}

class ClaimedElsewhere extends Error {
  constructor() {
    super("batch claimed by another run");
    this.name = "ClaimedElsewhere";
  }
}
