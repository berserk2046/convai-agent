import { z } from "zod";

/**
 * Parses WhatsApp Cloud API webhooks into flat events. Shapes follow Meta's messages
 * webhook reference (recorded examples in ../fixtures). Parsing is lenient about fields we
 * don't use, because Meta adds fields over time, but strict about the ones we rely on.
 */

const metadata = z.looseObject({ display_phone_number: z.string(), phone_number_id: z.string() });

const message = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  button: z.looseObject({ payload: z.string(), text: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  reaction: z.looseObject({ message_id: z.string(), emoji: z.string().optional() }).optional(),
  context: z.looseObject({ id: z.string().optional() }).optional(),
});

const statusError = z.looseObject({
  code: z.number(),
  title: z.string().optional(),
  message: z.string().optional(),
  error_data: z.looseObject({ details: z.string().optional() }).optional(),
});

const status = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
  pricing: z
    .looseObject({
      billable: z.boolean().optional(),
      pricing_model: z.string().optional(),
      type: z.string().optional(),
      category: z.string().optional(),
    })
    .optional(),
  errors: z.array(statusError).optional(),
});

/** `message_template_status_update` (Meta's webhook reference, fetched 2026-10-08). */
const templateStatus = z.looseObject({
  event: z.string(),
  message_template_id: z.union([z.number(), z.string()]),
  message_template_name: z.string(),
  message_template_language: z.string(),
  reason: z.string().nullable().optional(),
  message_template_category: z.string().optional(),
  rejection_info: z.looseObject({}).optional(),
  disable_info: z.looseObject({}).optional(),
  other_info: z.looseObject({}).optional(),
});

/** `template_category_update`: an announced change (correct_category) or a done one (previous_category). */
const templateCategory = z.looseObject({
  message_template_id: z.union([z.number(), z.string()]),
  message_template_name: z.string(),
  message_template_language: z.string(),
  new_category: z.string(),
  previous_category: z.string().optional(),
  correct_category: z.string().optional(),
  category_update_timestamp: z.number().optional(),
});

const change = z.looseObject({
  field: z.string(),
  value: z.looseObject({
    metadata: metadata.optional(),
    contacts: z
      .array(
        z.looseObject({
          wa_id: z.string(),
          profile: z.looseObject({ name: z.string() }).optional(),
        }),
      )
      .optional(),
    messages: z.array(message).optional(),
    statuses: z.array(status).optional(),
  }),
});

const payload = z.looseObject({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.looseObject({ id: z.string(), time: z.number().optional(), changes: z.array(change) }),
  ),
});

/** Message types the bot responds to; everything else is stored and left alone (B16). */
const ACTIONABLE_TYPES = new Set([
  "text",
  "button",
  "interactive",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
]);

export interface InboundMessage {
  waMessageId: string;
  /** Sender's WhatsApp id (phone number digits). */
  from: string;
  timestamp: Date;
  type: string;
  /** What the person wrote or tapped: text body, button text, list/button title, or caption. */
  text: string | null;
  /** Template quick-reply tap. */
  button: { payload: string; text: string } | null;
  /** Interactive reply (reply buttons or list). */
  interactive: { kind: string; id: string; title: string } | null;
  /** Reactions ignore this pipeline; kept for the record. */
  reaction: { messageId: string; emoji: string | null } | null;
  /** The message this one replies to, if any. */
  contextMessageId: string | null;
  /** WhatsApp profile name. Personal data: store only after consent (decision A10). */
  profileName: string | null;
  /** False for reactions, edits, system and unsupported messages: stored, never answered. */
  actionable: boolean;
  /** The message object as Meta sent it (contains message text: purged with retention). */
  raw: Record<string, unknown>;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;
  timestamp: Date;
  recipientId: string;
  pricing: {
    billable: boolean | null;
    model: string | null;
    type: string | null;
    category: string | null;
  } | null;
  errors: { code: number; title: string | null; details: string | null }[];
}

/** A Meta message template changed status (approved, rejected, paused…). */
export interface TemplateStatusUpdate {
  /** Meta's template id. Webhooks send it as a JSON number; match by name and language too. */
  templateId: string;
  name: string;
  /** Normalized to Meta's API form: "en-US" → "en_US". */
  language: string;
  /** Meta's event: APPROVED, REJECTED, PENDING, PAUSED, DISABLED, FLAGGED, REINSTATED… */
  event: string;
  reason: string | null;
  category: string | null;
  /** rejection_info, disable_info and other_info, when present. */
  info: Record<string, unknown>;
  at: Date;
}

/** Meta announced (or made) a category change; billing uses Meta's category (B31). */
export interface TemplateCategoryUpdate {
  templateId: string;
  name: string;
  language: string;
  /** Done change: the category from now on. Announced change: still the current one. */
  newCategory: string;
  previousCategory: string | null;
  /** Announced change: the category it will get, and when. */
  correctCategory: string | null;
  effectiveAt: Date | null;
  at: Date;
}

export type WebhookEvent =
  | { kind: "message"; phoneNumberId: string; message: InboundMessage }
  | { kind: "status"; phoneNumberId: string; status: StatusUpdate }
  | { kind: "template_status"; wabaId: string; update: TemplateStatusUpdate }
  | { kind: "template_category"; wabaId: string; update: TemplateCategoryUpdate }
  | { kind: "unhandled"; field: string; phoneNumberId: string | null };

export type ParseResult = { ok: true; events: WebhookEvent[] } | { ok: false; error: string };

export function parseWebhook(body: unknown): ParseResult {
  const parsed = payload.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }
  const events: WebhookEvent[] = [];
  for (const entry of parsed.data.entry) {
    const at = entry.time === undefined ? new Date() : fromUnixSeconds(String(entry.time));
    for (const { field, value } of entry.changes) {
      const template = templateEvent(field, value, entry.id, at);
      if (template) {
        events.push(template);
        continue;
      }
      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      if (field !== "messages" || phoneNumberId === null) {
        events.push({ kind: "unhandled", field, phoneNumberId });
        continue;
      }
      const names = new Map(value.contacts?.map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of value.messages ?? []) {
        events.push({
          kind: "message",
          phoneNumberId,
          message: toInboundMessage(m, names.get(m.from) ?? null),
        });
      }
      for (const s of value.statuses ?? []) {
        events.push({ kind: "status", phoneNumberId, status: toStatusUpdate(s) });
      }
    }
  }
  return { ok: true, events };
}

/** Template webhooks carry the WABA id in entry.id and no phone number metadata. */
function templateEvent(
  field: string,
  value: unknown,
  wabaId: string,
  at: Date,
): WebhookEvent | null {
  if (field === "message_template_status_update") {
    const v = templateStatus.safeParse(value);
    if (!v.success) return null;
    const { rejection_info, disable_info, other_info } = v.data;
    return {
      kind: "template_status",
      wabaId,
      update: {
        templateId: String(v.data.message_template_id),
        name: v.data.message_template_name,
        language: metaLanguage(v.data.message_template_language),
        event: v.data.event,
        reason: v.data.reason ?? null,
        category: v.data.message_template_category ?? null,
        info: Object.fromEntries(
          Object.entries({ rejection_info, disable_info, other_info }).filter(
            ([, x]) => x !== undefined,
          ),
        ),
        at,
      },
    };
  }
  if (field === "template_category_update") {
    const v = templateCategory.safeParse(value);
    if (!v.success) return null;
    return {
      kind: "template_category",
      wabaId,
      update: {
        templateId: String(v.data.message_template_id),
        name: v.data.message_template_name,
        language: metaLanguage(v.data.message_template_language),
        newCategory: v.data.new_category,
        previousCategory: v.data.previous_category ?? null,
        correctCategory: v.data.correct_category ?? null,
        effectiveAt:
          v.data.category_update_timestamp === undefined
            ? null
            : fromUnixSeconds(String(v.data.category_update_timestamp)),
        at,
      },
    };
  }
  return null;
}

/** Webhooks write "en-US" where the template API uses "en_US". */
export function metaLanguage(code: string): string {
  return code.replace("-", "_");
}

function toInboundMessage(m: z.infer<typeof message>, profileName: string | null): InboundMessage {
  const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
  return {
    waMessageId: m.id,
    from: m.from,
    timestamp: fromUnixSeconds(m.timestamp),
    type: m.type,
    text: m.text?.body ?? m.button?.text ?? reply?.title ?? caption(m),
    button: m.button ? { payload: m.button.payload, text: m.button.text } : null,
    interactive:
      m.interactive && reply
        ? { kind: m.interactive.type, id: reply.id, title: reply.title }
        : null,
    reaction: m.reaction
      ? { messageId: m.reaction.message_id, emoji: m.reaction.emoji ?? null }
      : null,
    contextMessageId: m.context?.id ?? null,
    profileName,
    actionable: ACTIONABLE_TYPES.has(m.type),
    raw: m,
  };
}

/** Media messages (image, video, document) may carry a caption. */
function caption(m: Record<string, unknown>): string | null {
  const media = m[String(m.type)];
  const value =
    typeof media === "object" && media !== null
      ? (media as Record<string, unknown>).caption
      : undefined;
  return typeof value === "string" ? value : null;
}

function toStatusUpdate(s: z.infer<typeof status>): StatusUpdate {
  return {
    waMessageId: s.id,
    status: s.status,
    timestamp: fromUnixSeconds(s.timestamp),
    recipientId: s.recipient_id,
    pricing: s.pricing
      ? {
          billable: s.pricing.billable ?? null,
          model: s.pricing.pricing_model ?? null,
          type: s.pricing.type ?? null,
          category: s.pricing.category ?? null,
        }
      : null,
    errors: (s.errors ?? []).map((e) => ({
      code: e.code,
      title: e.title ?? e.message ?? null,
      details: e.error_data?.details ?? null,
    })),
  };
}

function fromUnixSeconds(value: string): Date {
  return new Date(Number(value) * 1000);
}
