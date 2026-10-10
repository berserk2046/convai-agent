import { randomUUID } from "node:crypto";
import { fillBody, resolveVariables } from "@platform/automations/admin";
import { serviceWindow } from "@platform/channels";
import { WindowClosedError, sendTemplate, sendText } from "@platform/core/outbound";
import {
  countTemplateMessagesSince,
  countUnreadNotifications,
  getContact,
  getContactBooking,
  getConversation,
  getOpenHandoff,
  getResource,
  grantConsent,
  listContactBookings,
  listInboxConversations,
  listStaffNotifications,
  listThread,
  listWaTemplates,
  markNotificationsRead,
  openHandoff,
  optInContact,
  preparedTemplateFor,
  resolveHandoff,
  type BookingRow,
  type ContactRow,
  type HandoffRow,
  type MessageRow,
} from "@platform/db";
import {
  buildBookingContext,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  metaTemplateName,
  parseSemver,
  type Context,
  type PreparedTemplate,
  type WaTemplate,
} from "@platform/templates";
import { DateTime } from "luxon";
import type { Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";
import {
  authoredContactFields,
  handoffLabels,
  inBusiness,
  pinnedRow,
  pinnedTemplate,
  type Scope,
} from "../tenancy.ts";
import { slotLabel } from "../time.ts";

/**
 * /inbox (spec §12): conversations with open handoffs first; staff replies free-form inside
 * the 24-hour window and with an approved template outside it; closing a handoff gives the
 * conversation back to the bot (principle 7). Staff and admins.
 */

export interface OpenHandoff {
  reason: string;
  /** The template's name for the reason, when it gives one. */
  label: string | null;
  summary: string | null;
  openedAt: Date;
}

function openHandoffView(handoff: HandoffRow, labels: Record<string, string>): OpenHandoff {
  return {
    reason: handoff.reason,
    label: labels[handoff.reason] ?? null,
    summary: handoff.summary,
    openedAt: handoff.openedAt,
  };
}

export interface InboxItem {
  conversationId: string;
  /** What staff call the person: their name, else their WhatsApp profile name, else the number. */
  title: string;
  waNumber: string;
  mode: "bot" | "human";
  handoff: OpenHandoff | null;
  last: { direction: "inbound" | "outbound"; preview: string; at: Date } | null;
}

export async function listInbox(
  deps: ServiceDeps,
  actor: Actor,
  options: { onlyHandoffs?: boolean } = {},
): Promise<InboxItem[]> {
  return inBusiness(deps, actor, undefined, async (scope) => {
    const rows = await listInboxConversations(scope.tx, scope.business.id, options);
    const labels = handoffLabels((await pinnedRow(scope)).manifest);
    return rows.map(({ conversation, contact, handoff, lastMessage }) => ({
      conversationId: conversation.id,
      title: displayName(contact),
      waNumber: contact.waNumber,
      mode: conversation.mode,
      handoff: handoff ? openHandoffView(handoff, labels) : null,
      last: lastMessage
        ? {
            direction: lastMessage.direction,
            preview: preview(lastMessage.body, lastMessage.type),
            at: lastMessage.createdAt,
          }
        : null,
    }));
  });
}

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  /** "customer", "agent" (AI), "auto" (fixed or automatic message), "staff". */
  author: "customer" | "agent" | "auto" | "staff";
  staffName: string | null;
  body: string;
  status: string;
  at: Date;
}

export interface ConversationView {
  conversationId: string;
  mode: "bot" | "human";
  contact: {
    id: string;
    title: string;
    name: string | null;
    profileName: string | null;
    waNumber: string;
    fields: { key: string; title: string; value: string }[];
    consent: { at: Date; source: string | null } | null;
    optedOutAt: Date | null;
  };
  handoff: OpenHandoff | null;
  /** WhatsApp's 24-hour window: free-form replies only while it's open. */
  window: { open: boolean; closesAt: Date | null };
  messages: ThreadMessage[];
  bookings: { id: string; label: string; service: string; status: string }[];
  /** Approved templates staff can send (always allowed, even outside the window). */
  templates: { key: string; name: string; preview: string; needsBooking: boolean }[];
}

export async function getConversationView(
  deps: ServiceDeps,
  actor: Actor,
  conversationId: string,
): Promise<ConversationView> {
  requireIds("conversation", conversationId);
  return inBusiness(deps, actor, undefined, async (scope) => {
    const { tx, business } = scope;
    const { conversation, contact } = await conversationOf(scope, conversationId);
    const row = await pinnedRow(scope);
    const prepared = preparedTemplateFor(row);
    const now = deps.now();
    const zone = business.timezone;
    const handoff = await getOpenHandoff(tx, conversation.id);
    const thread = await listThread(tx, conversation.id);
    const bookings = await listContactBookings(tx, contact.id, { from: now });
    const templates = await approvedTemplates(scope, prepared);
    const context = await templateContext(scope, prepared, contact, bookings[0] ?? null, now);
    const fieldSchemas = prepared.template.contact_fields ?? {};

    return {
      conversationId: conversation.id,
      mode: conversation.mode,
      contact: {
        id: contact.id,
        title: displayName(contact),
        name: contact.name,
        profileName: contact.waProfileName,
        waNumber: contact.waNumber,
        fields: authoredContactFields(row).map((key) => {
          const title = fieldSchemas[key]?.title;
          return {
            key,
            title: typeof title === "string" ? title : key,
            value: fieldText(contact.fields[key]),
          };
        }),
        consent: contact.consentAt
          ? { at: contact.consentAt, source: contact.consentSource }
          : null,
        optedOutAt: contact.optedOutAt,
      },
      handoff: handoff ? openHandoffView(handoff, handoffLabels(prepared.template)) : null,
      window: serviceWindow(conversation.lastInboundAt, now),
      messages: thread.map(threadMessage),
      bookings: bookings.map((b) => ({
        id: b.id,
        label: slotLabel(b.startsAt, zone),
        service: b.serviceName,
        status: b.status,
      })),
      templates: templates.map((wa) => {
        const resolved = resolveVariables(wa, context);
        return {
          key: wa.key,
          name: metaTemplateName(wa.key, major(prepared)),
          preview: fillBody(wa.body, resolved.ok ? resolved.values : wa.examples),
          needsBooking: usesBooking(wa),
        };
      }),
    };
  });
}

/**
 * A staff reply (free-form, inside the 24-hour window). Replying takes the conversation
 * over: a handoff opens, so the bot stays silent until staff close it (principle 7).
 * `clientId` is generated by the form, so a resubmitted form never sends twice.
 */
export async function replyToConversation(
  deps: ServiceDeps,
  actor: Actor,
  conversationId: string,
  input: { text: string; clientId: string },
): Promise<void> {
  requireIds("conversation", conversationId);
  const text = input.text.trim();
  if (text === "") throw new ActionRefusedError("empty", "Escriba un mensaje.");
  if (text.length > 4096) {
    throw new ActionRefusedError(
      "too_long",
      "El mensaje es demasiado largo (máximo 4.096 caracteres).",
    );
  }
  const businessId = await inBusiness(deps, actor, undefined, async (scope) => {
    const { conversation } = await conversationOf(scope, conversationId);
    if (!serviceWindow(conversation.lastInboundAt, deps.now()).open) throw windowClosed();
    await takeOver(scope, conversation.id);
    await scope.audit("inbox.reply", { conversation_id: conversation.id });
    return scope.business.id;
  });
  try {
    await sendText(deps, {
      businessId,
      conversationId,
      body: text,
      idempotencyKey: `staff:${clientKey(input.clientId)}`,
      details: { kind: "staff", user_id: actor.userId, user_name: actor.name },
    });
  } catch (error) {
    if (error instanceof WindowClosedError) throw windowClosed();
    throw error;
  }
}

/** An approved template, e.g. to reach someone outside the 24-hour window. */
export async function sendTemplateToConversation(
  deps: ServiceDeps,
  actor: Actor,
  conversationId: string,
  input: { templateKey: string; bookingId: string | null; clientId: string },
): Promise<void> {
  requireIds("conversation", conversationId, input.bookingId);
  const send = await inBusiness(deps, actor, undefined, async (scope) => {
    const { tx, business } = scope;
    const { conversation, contact } = await conversationOf(scope, conversationId);
    const prepared = await pinnedTemplate(scope);
    const wa = (await approvedTemplates(scope, prepared)).find((t) => t.key === input.templateKey);
    if (!wa) {
      throw new ActionRefusedError("not_approved", "Esa plantilla no está aprobada por Meta.");
    }
    const booking = input.bookingId
      ? await getContactBooking(tx, input.bookingId, contact.id)
      : null;
    if (input.bookingId && !booking) throw new NotFoundError("booking");
    if (usesBooking(wa) && !booking) {
      throw new ActionRefusedError(
        "booking_required",
        "Elija la cita a la que se refiere el mensaje.",
      );
    }
    const now = deps.now();
    const context = await templateContext(scope, prepared, contact, booking, now);
    const resolved = resolveVariables(wa, context);
    if (!resolved.ok) {
      throw new ActionRefusedError(
        "missing_variable",
        "Faltan datos para este mensaje (por ejemplo, el nombre del cliente).",
      );
    }
    const name = metaTemplateName(wa.key, major(prepared));
    const row = (await listWaTemplates(tx, business.id)).find(
      (r) => r.metaName === name && r.language === wa.language,
    );
    const category = row?.categoryMeta ?? row?.categoryRequested ?? wa.category;
    if (category === "MARKETING") {
      const monthStart = DateTime.fromJSDate(now, { zone: business.timezone }).startOf("month");
      const sent = await countTemplateMessagesSince(
        tx,
        business.id,
        "MARKETING",
        monthStart.toJSDate(),
      );
      const cap = business.limits.marketing_msgs_month ?? deps.marketingMsgsMonth;
      if (sent >= cap) {
        throw new ActionRefusedError(
          "marketing_cap",
          "Se alcanzó el límite mensual de mensajes de marketing.",
        );
      }
    }
    await scope.audit("inbox.template", { conversation_id: conversation.id, template: name });
    // Button taps on a template staff sent reach the agent (or staff during a handoff).
    const buttons = wa.buttons.map((b) => ({
      text: b.text,
      payload: `staff:${randomUUID()}:${b.payload}`,
    }));
    return {
      businessId: business.id,
      template: {
        name,
        languageCode: wa.language,
        bodyParameters: resolved.values,
        quickReplyPayloads: buttons.map((b) => b.payload),
      },
      preview: fillBody(wa.body, resolved.values),
      category,
      buttons,
    };
  });
  await sendTemplate(deps, {
    businessId: send.businessId,
    conversationId,
    template: send.template,
    idempotencyKey: `staff:${clientKey(input.clientId)}`,
    preview: send.preview,
    category: send.category,
    buttons: send.buttons,
    details: { kind: "staff", user_id: actor.userId, user_name: actor.name },
  });
}

/** Staff take the conversation over: the bot stays silent until they close the handoff. */
export async function takeOverConversation(
  deps: ServiceDeps,
  actor: Actor,
  conversationId: string,
): Promise<void> {
  requireIds("conversation", conversationId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const { conversation } = await conversationOf(scope, conversationId);
    await takeOver(scope, conversation.id);
  });
}

/** Closes the handoff: the bot answers this conversation again (spec §12). */
export async function closeHandoff(
  deps: ServiceDeps,
  actor: Actor,
  conversationId: string,
): Promise<void> {
  requireIds("conversation", conversationId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const { conversation } = await conversationOf(scope, conversationId);
    await resolveHandoff(scope.tx, conversation.id, actor.userId);
    await scope.audit("handoff.close", { conversation_id: conversation.id });
  });
}

/** Decision A2: automatic messages again for a contact who opted out (asked in person). */
export async function reenableAutomaticMessages(
  deps: ServiceDeps,
  actor: Actor,
  contactId: string,
): Promise<void> {
  requireIds("contact", contactId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    if (!(await optInContact(scope.tx, contactId))) throw new NotFoundError("contact");
    await scope.audit("contact.reenable", { contact_id: contactId });
  });
}

/** Decision A13 (Ley 1581): staff record that the person authorized data processing. */
export async function recordConsent(
  deps: ServiceDeps,
  actor: Actor,
  contactId: string,
  input: { confirmed: boolean },
): Promise<void> {
  requireIds("contact", contactId);
  if (!input.confirmed) {
    throw new ActionRefusedError(
      "consent_required",
      "Confirme que el cliente autorizó el tratamiento de sus datos.",
    );
  }
  await inBusiness(deps, actor, undefined, async (scope) => {
    const contact = await getContact(scope.tx, contactId);
    if (!contact) throw new NotFoundError("contact");
    await grantConsent(scope.tx, contact.id, "staff", deps.now());
    await scope.audit("contact.consent", { contact_id: contact.id });
  });
}

// --- notifications (decision A15) --------------------------------------------------------------

export interface NotificationItem {
  id: string;
  kind: string;
  text: string;
  conversationId: string | null;
  at: Date;
  read: boolean;
}

export async function listNotifications(
  deps: ServiceDeps,
  actor: Actor,
  options: { unreadOnly?: boolean } = {},
): Promise<NotificationItem[]> {
  return inBusiness(deps, actor, undefined, async ({ tx, business }) =>
    (await listStaffNotifications(tx, business.id, options)).map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      conversationId:
        typeof n.payload.conversation_id === "string" ? n.payload.conversation_id : null,
      at: n.createdAt,
      read: n.readAt !== null,
    })),
  );
}

export async function unreadNotificationCount(deps: ServiceDeps, actor: Actor): Promise<number> {
  return inBusiness(deps, actor, undefined, ({ tx, business }) =>
    countUnreadNotifications(tx, business.id),
  );
}

export async function markRead(
  deps: ServiceDeps,
  actor: Actor,
  ids: readonly string[] | null,
): Promise<void> {
  requireIds("notification", ...(ids ?? []));
  await inBusiness(deps, actor, undefined, ({ tx, business }) =>
    markNotificationsRead(tx, business.id, ids, deps.now()),
  );
}

// --- helpers ----------------------------------------------------------------------------------

async function conversationOf(scope: Scope, conversationId: string) {
  const conversation = await getConversation(scope.tx, conversationId);
  const contact = conversation ? await getContact(scope.tx, conversation.contactId) : null;
  if (!conversation || !contact) throw new NotFoundError("conversation");
  return { conversation, contact };
}

async function takeOver(scope: Scope, conversationId: string): Promise<void> {
  const { created } = await openHandoff(scope.tx, {
    businessId: scope.business.id,
    conversationId,
    reason: "staff",
    summary: null,
  });
  if (created) await scope.audit("handoff.open", { conversation_id: conversationId });
}

async function approvedTemplates(scope: Scope, prepared: PreparedTemplate): Promise<WaTemplate[]> {
  const rows = await listWaTemplates(scope.tx, scope.business.id);
  return prepared.template.wa_templates.filter((wa) =>
    rows.some(
      (r) =>
        r.metaName === metaTemplateName(wa.key, major(prepared)) &&
        r.language === wa.language &&
        r.metaStatus === "APPROVED",
    ),
  );
}

async function templateContext(
  scope: Scope,
  prepared: PreparedTemplate,
  contact: ContactRow,
  booking: BookingRow | null,
  now: Date,
): Promise<Context> {
  const { business, tx } = scope;
  const zone = business.timezone;
  const facts = (b: BookingRow, resourceName: string | null) => ({
    id: b.id,
    service_key: b.serviceKey,
    service_name: b.serviceName,
    subject_name: b.subjectName,
    party_size: b.partySize,
    status: b.status,
    source: b.source,
    starts_at: DateTime.fromJSDate(b.startsAt, { zone }),
    ends_at: DateTime.fromJSDate(b.endsAt, { zone }),
    resource_name: resourceName,
    notes: b.notes,
  });
  const context: Context = {
    business: buildBusinessContext(business.config ?? {}, prepared.config.schema, zone),
    now: buildNowContext(DateTime.fromJSDate(now, { zone }), business.holidays.open_holidays),
    contact: buildContactContext(
      { name: contact.name, fields: contact.fields, upcomingBookings: [] },
      Object.keys(prepared.template.contact_fields ?? {}),
    ),
  };
  if (booking) {
    const resource = await getResource(tx, booking.resourceId);
    context.booking = buildBookingContext(facts(booking, resource?.name ?? null));
  }
  return context;
}

function usesBooking(wa: WaTemplate): boolean {
  return wa.variables.some((v) =>
    (typeof v === "string" ? [v] : v.paths).some((p) => p.startsWith("booking.")),
  );
}

function major(prepared: PreparedTemplate): number {
  return parseSemver(prepared.template.manifest.version)?.major ?? 1;
}

function displayName(contact: ContactRow): string {
  return contact.name ?? contact.waProfileName ?? `+${contact.waNumber}`;
}

function preview(body: string | null, type: string): string {
  const text = body?.replace(/\s+/g, " ").trim() ?? "";
  if (text === "") return `[${type}]`;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function fieldText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);
}

function threadMessage(m: MessageRow): ThreadMessage {
  const kind = m.payload.kind;
  const author: ThreadMessage["author"] =
    m.direction === "inbound"
      ? "customer"
      : kind === "staff"
        ? "staff"
        : kind === "agent"
          ? "agent"
          : "auto";
  return {
    id: m.id,
    direction: m.direction,
    author,
    staffName: typeof m.payload.user_name === "string" ? m.payload.user_name : null,
    body: m.body ?? `[${m.type}]`,
    status: m.status,
    at: m.createdAt,
  };
}

/** Form-generated ids stay short and safe inside idempotency keys. */
function clientKey(clientId: string): string {
  if (!/^[\w-]{8,64}$/.test(clientId)) {
    throw new ActionRefusedError("bad_request", "Vuelva a cargar la página e intente de nuevo.");
  }
  return clientId;
}

function windowClosed(): ActionRefusedError {
  return new ActionRefusedError(
    "window_closed",
    "Pasaron más de 24 horas desde el último mensaje del cliente: solo puede enviarle una plantilla aprobada.",
  );
}
