import type { InboundMessage, StatusUpdate, WebhookEvent } from "@platform/channels";
import {
  applyStatusUpdate,
  ensureConversation,
  findActiveChannelByPhoneNumberId,
  insertInboundMessage,
  isDeliveryStatus,
  recordInbound,
  setWaProfileName,
  upsertContact,
  withTenant,
  type Database,
} from "@platform/db";
import { alert, type Logger } from "@platform/shared";
import type { InboundJobData } from "./queue.ts";

/**
 * Webhook ingestion (spec §3): resolve the business from the phone number id, store each
 * message once, enqueue a debounced batch job, apply delivery statuses. Fast and
 * idempotent, so Meta re-deliveries are harmless.
 */

export interface IngestDeps {
  db: Database;
  logger: Logger;
  resolveChannel: ChannelResolver;
  enqueue: (data: InboundJobData & { waNumber: string }) => Promise<void>;
}

export interface IngestSummary {
  stored: number;
  duplicates: number;
  statuses: number;
  unknownPhoneNumberIds: string[];
}

export async function ingestWebhookEvents(
  deps: IngestDeps,
  events: readonly WebhookEvent[],
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    stored: 0,
    duplicates: 0,
    statuses: 0,
    unknownPhoneNumberIds: [],
  };
  for (const event of events) {
    if (event.kind === "unhandled") {
      deps.logger.debug({ field: event.field }, "webhook field not handled");
      continue;
    }
    const businessId = await deps.resolveChannel(event.phoneNumberId);
    if (businessId === null) {
      if (!summary.unknownPhoneNumberIds.includes(event.phoneNumberId)) {
        summary.unknownPhoneNumberIds.push(event.phoneNumberId);
      }
      continue;
    }
    if (event.kind === "message") {
      const stored = await storeMessage(deps, businessId, event.message);
      if (stored) summary.stored += 1;
      else summary.duplicates += 1;
    } else {
      await storeStatus(deps, businessId, event.status);
      summary.statuses += 1;
    }
  }
  if (summary.unknownPhoneNumberIds.length > 0) {
    // Decision A4: answer 200 anyway (retries can't fix this), but tell someone.
    alert(
      deps.logger,
      "wa_unknown_phone_number",
      { phone_number_ids: summary.unknownPhoneNumberIds },
      "webhook for a phone number with no active channel",
    );
  }
  return summary;
}

async function storeMessage(
  deps: IngestDeps,
  businessId: string,
  message: InboundMessage,
): Promise<boolean> {
  const result = await withTenant(deps.db, businessId, async (tx) => {
    const contact = await upsertContact(tx, businessId, message.from);
    // Decision A10: the profile name is personal data, kept (for staff) only after consent.
    if (contact.consentAt && message.profileName && message.profileName !== contact.waProfileName) {
      await setWaProfileName(tx, contact.id, message.profileName);
    }
    const conversation = await ensureConversation(tx, businessId, contact.id);
    const row = await insertInboundMessage(tx, {
      businessId,
      conversationId: conversation.id,
      waMessageId: message.waMessageId,
      type: message.type,
      body: message.text,
      payload: { message: message.raw },
      waTimestamp: message.timestamp,
      alreadyProcessed: !message.actionable,
    });
    if (row && message.actionable) await recordInbound(tx, conversation.id, message.timestamp);
    return { row, conversationId: conversation.id };
  });
  if (!result.row) return false;

  deps.logger.info(
    {
      business_id: businessId,
      conversation_id: result.conversationId,
      message_id: result.row.id,
      type: message.type,
    },
    "inbound message stored",
  );
  if (message.actionable) {
    await deps.enqueue({
      businessId,
      conversationId: result.conversationId,
      waNumber: message.from,
    });
  }
  return true;
}

async function storeStatus(
  deps: IngestDeps,
  businessId: string,
  status: StatusUpdate,
): Promise<void> {
  if (!isDeliveryStatus(status.status)) {
    deps.logger.debug({ status: status.status }, "unknown delivery status ignored");
    return;
  }
  const error = status.errors[0] ? { kind: "delivery", ...status.errors[0] } : null;
  const updated = await withTenant(deps.db, businessId, (tx) =>
    applyStatusUpdate(tx, {
      waMessageId: status.waMessageId,
      status: status.status as Parameters<typeof applyStatusUpdate>[1]["status"],
      at: status.timestamp,
      pricing: status.pricing ? { ...status.pricing } : null,
      error,
    }),
  );
  if (updated && status.status === "failed") {
    alert(
      deps.logger,
      "wa_delivery_failed",
      { business_id: businessId, message_id: updated.id, errors: status.errors },
      "WhatsApp could not deliver a message",
    );
  }
}

export type ChannelResolver = (phoneNumberId: string) => Promise<string | null>;

/** phone_number_id → business id, cached briefly (webhooks are frequent, channels rarely change). */
export function createChannelResolver(db: Database, ttlMs = 60_000): ChannelResolver {
  const cache = new Map<string, { businessId: string | null; expires: number }>();
  return async (phoneNumberId) => {
    const hit = cache.get(phoneNumberId);
    if (hit && hit.expires > Date.now()) return hit.businessId;
    const channel = await findActiveChannelByPhoneNumberId(db, phoneNumberId);
    const businessId = channel?.businessId ?? null;
    cache.set(phoneNumberId, { businessId, expires: Date.now() + ttlMs });
    return businessId;
  };
}
