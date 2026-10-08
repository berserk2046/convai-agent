import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.ts";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** A WhatsApp number connected to a business. One active channel per business (v1). */
export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    provider: text("provider", { enum: ["whatsapp_cloud"] })
      .notNull()
      .default("whatsapp_cloud"),
    phoneNumberId: text("phone_number_id").notNull().unique(),
    wabaId: text("waba_id").notNull(),
    displayPhone: text("display_phone").notNull(),
    /** Sealed with @platform/shared's SecretBox, context `channel:<phone_number_id>`. */
    tokenEncrypted: text("token_encrypted").notNull(),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channels_one_active_per_business")
      .on(t.businessId)
      .where(sql`${t.status} = 'active'`),
    check("channels_status_check", sql`${t.status} in ('active', 'disabled')`),
    check("channels_provider_check", sql`${t.provider} in ('whatsapp_cloud')`),
  ],
);

/** A person who wrote to (or was messaged by) a business. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    waNumber: text("wa_number").notNull(),
    /** A name the person typed (decision A10); null until then. */
    name: text("name"),
    /** WhatsApp profile name; stored only after consent, shown to staff only (A10). */
    waProfileName: text("wa_profile_name"),
    /** Template contact_fields, validated against the template on write. */
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    consentAt: tz("consent_at"),
    /** When the consent message was last sent (decision A9: once, re-sent at most daily). */
    consentRequestedAt: tz("consent_requested_at"),
    consentSource: text("consent_source", { enum: ["whatsapp", "staff"] }),
    optedOutAt: tz("opted_out_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("contacts_business_wa_number_key").on(t.businessId, t.waNumber),
    check("contacts_consent_source_check", sql`${t.consentSource} in ('whatsapp', 'staff')`),
  ],
);

/** One conversation per contact; `mode` says whether the bot or a human answers. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    contactId: uuid("contact_id")
      .notNull()
      .unique()
      .references(() => contacts.id),
    mode: text("mode", { enum: ["bot", "human"] })
      .notNull()
      .default("bot"),
    /** Start of the 24-hour customer service window. */
    lastInboundAt: tz("last_inbound_at"),
    lastOutboundAt: tz("last_outbound_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [check("conversations_mode_check", sql`${t.mode} in ('bot', 'human')`)],
);

export const MESSAGE_STATUSES = [
  "received",
  "pending",
  "sent",
  "delivered",
  "read",
  "played",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    /** Meta message type: text, button, interactive, image, template, reaction… */
    type: text("type").notNull(),
    /** Readable text; nulled by the retention job (spec §13). */
    body: text("body"),
    /** Structured details (Meta's message object, template parameters…); text purged with body. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    waMessageId: text("wa_message_id").unique(),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    statusAt: tz("status_at"),
    /** When the person sent it (inbound) or Meta reported the status (outbound). */
    waTimestamp: tz("wa_timestamp"),
    /** Inbound: when the batch containing it was handled. Null = waiting for the worker. */
    processedAt: tz("processed_at"),
    /** Outbound: makes a retried send a no-op (spec review B15). */
    idempotencyKey: text("idempotency_key"),
    /** Outbound: set right before calling Meta; set without a wamid = outcome unknown. */
    sendAttemptedAt: tz("send_attempted_at"),
    /** Latest `pricing` from status webhooks (billable, category…). */
    pricing: jsonb("pricing").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    toolCalls: jsonb("tool_calls").$type<unknown[]>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // clock_timestamp(), not now(): several replies inserted in one transaction must keep
    // their order (now() is the transaction's start time, the same for all of them).
    createdAt: tz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("messages_business_idempotency_key").on(t.businessId, t.idempotencyKey),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("messages_unprocessed_inbound_idx")
      .on(t.conversationId)
      .where(sql`${t.direction} = 'inbound' and ${t.processedAt} is null`),
    check("messages_direction_check", sql`${t.direction} in ('inbound', 'outbound')`),
    check(
      "messages_status_check",
      sql`${t.status} in ('received', 'pending', 'sent', 'delivered', 'read', 'played', 'failed')`,
    ),
  ],
);

export type ChannelRow = typeof channels.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
