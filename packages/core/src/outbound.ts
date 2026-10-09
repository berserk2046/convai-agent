import {
  WhatsAppSendError,
  serviceWindow,
  type Sender,
  type TemplateMessage,
} from "@platform/channels";
import {
  channelAccessToken,
  getActiveChannel,
  getContact,
  getConversation,
  insertOutboundMessage,
  listUnsentOutbound,
  markOutboundFailed,
  markOutboundSent,
  markSendAttempted,
  recordOutbound,
  releaseSendAttempt,
  withTenant,
  type MessageRow,
} from "@platform/db";
import { alert } from "@platform/shared";
import type { CoreDeps } from "./deps.ts";

/**
 * Outgoing messages are written down first (status pending, idempotency key) and sent
 * second. Exactly-once where Meta lets us know the outcome; at-most-once when it doesn't
 * (spec review B15): a message whose send was attempted but never confirmed is never resent.
 */

export class WindowClosedError extends Error {
  constructor() {
    super("the 24-hour customer service window is closed; only templates can be sent");
    this.name = "WindowClosedError";
  }
}

/** Template message details stored in the outbound row's payload. */
export type TemplatePayload = Omit<TemplateMessage, "to">;

export interface QueueTextInput {
  businessId: string;
  conversationId: string;
  body: string;
  idempotencyKey: string;
}

/**
 * Sends free-form text (staff replies, automation texts). Refused outside the 24-hour
 * window. Returns null if this idempotency key was already used.
 */
export async function sendText(deps: CoreDeps, input: QueueTextInput): Promise<MessageRow | null> {
  const row = await withTenant(deps.db, input.businessId, async (tx) => {
    const conversation = await getConversation(tx, input.conversationId);
    if (!conversation) throw new Error("conversation not found");
    if (!serviceWindow(conversation.lastInboundAt, deps.now()).open) throw new WindowClosedError();
    return insertOutboundMessage(tx, { ...input, type: "text" });
  });
  await deliverPending(deps, input.businessId, input.conversationId);
  return row;
}

export interface QueueTemplateInput {
  businessId: string;
  conversationId: string;
  template: TemplatePayload;
  idempotencyKey: string;
  /** The body with its parameters filled in: what the person reads. */
  preview: string;
  /** Meta's category for this template (requested one until Meta reports its own). */
  category: string;
  /** Quick-reply buttons as sent: text and full payload (typed replies, decision A11). */
  buttons?: readonly { text: string; payload: string }[];
  /** Extra details kept with the message, e.g. the automation run that sent it. */
  details?: Record<string, unknown>;
}

/** Sends an approved template (allowed outside the window). Null if the key was used already. */
export async function sendTemplate(
  deps: CoreDeps,
  input: QueueTemplateInput,
): Promise<MessageRow | null> {
  const row = await withTenant(deps.db, input.businessId, (tx) =>
    insertOutboundMessage(tx, {
      businessId: input.businessId,
      conversationId: input.conversationId,
      type: "template",
      // What the person reads, for the inbox and history; purged with retention.
      body: input.preview,
      payload: {
        ...input.details,
        template: input.template,
        category: input.category,
        buttons: input.buttons ?? [],
      },
      idempotencyKey: input.idempotencyKey,
    }),
  );
  await deliverPending(deps, input.businessId, input.conversationId);
  return row;
}

/**
 * Sends every pending message of a conversation that nobody has tried yet, in order.
 * Throws on a transient failure (after releasing that message) so the job retries.
 */
export async function deliverPending(
  deps: CoreDeps,
  businessId: string,
  conversationId: string,
): Promise<void> {
  const { channel, contact, pending } = await withTenant(deps.db, businessId, async (tx) => {
    const conversation = await getConversation(tx, conversationId);
    return {
      channel: await getActiveChannel(tx, businessId),
      contact: conversation ? await getContact(tx, conversation.contactId) : null,
      pending: await listUnsentOutbound(tx, conversationId),
    };
  });
  if (pending.length === 0) return;
  const log = deps.logger.child({ business_id: businessId, conversation_id: conversationId });

  if (!channel || !contact) {
    for (const message of pending) {
      await withTenant(deps.db, businessId, (tx) =>
        markOutboundFailed(tx, message.id, {
          kind: "config",
          message: "no active WhatsApp channel",
        }),
      );
    }
    alert(
      log,
      "wa_no_channel",
      { pending: pending.length },
      "messages can't be sent: business has no active channel",
    );
    return;
  }
  const sender: Sender = {
    phoneNumberId: channel.phoneNumberId,
    accessToken: channelAccessToken(channel, deps.secrets),
  };

  for (const message of pending) {
    const claimed = await withTenant(deps.db, businessId, (tx) =>
      markSendAttempted(tx, message.id),
    );
    if (!claimed) continue;
    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send(deps, sender, contact.waNumber, message);
    } catch (error) {
      if (error instanceof WhatsAppSendError && error.kind !== "transient") {
        await withTenant(deps.db, businessId, (tx) =>
          markOutboundFailed(tx, message.id, error.toJSON()),
        );
        alert(
          log,
          `wa_send_${error.kind}`,
          { message_id: message.id, error: error.toJSON() },
          "message not sent",
        );
        continue;
      }
      // Meta didn't take it (or our own code failed before the request): safe to retry.
      await withTenant(deps.db, businessId, (tx) => releaseSendAttempt(tx, message.id));
      throw error;
    }
    // Sent. If recording that fails, the attempt mark stays set, so it is never resent.
    await withTenant(deps.db, businessId, async (tx) => {
      await markOutboundSent(tx, message.id, result);
      await recordOutbound(tx, conversationId, deps.now());
    });
    log.info({ message_id: message.id, wa_message_id: result.waMessageId }, "message sent");
  }
}

function send(deps: CoreDeps, sender: Sender, to: string, message: MessageRow) {
  if (message.type === "template") {
    const template = message.payload.template as TemplatePayload;
    return deps.whatsapp.sendTemplate(sender, { ...template, to });
  }
  return deps.whatsapp.sendText(sender, { to, body: message.body ?? "" });
}
