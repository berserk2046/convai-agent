import { randomInt, randomUUID } from "node:crypto";
import type { InboundMessage } from "@platform/channels";
import {
  createAgentResponder,
  ingestWebhookEvents,
  processInboundBatch,
  type BookingEvent,
  type Reply,
  type Responder,
  type ToolCallLog,
} from "@platform/core";
import {
  bookings,
  businesses,
  channels,
  contacts,
  conversations,
  createBusiness,
  createChannel,
  createClosure,
  createResource,
  ensureConversation,
  getTemplateVersion,
  handoffs,
  insertBooking,
  resolveHandoff,
  saveTemplateDraft,
  setTemplateStatus,
  upsertContact,
  withTenant,
  type Database,
  type HolidaySettings,
  type TemplateRow,
  type WeeklySchedule,
} from "@platform/db";
import type { LlmClient, TokenUsage } from "@platform/llm";
import { builtinProvider } from "@platform/scheduling";
import { createSecretBox, formatSlotLabel, type Logger } from "@platform/shared";
import { getPath, resolveBookingRules } from "@platform/templates";
import { asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { captureChannel } from "./channel.ts";
import { meterCalls } from "./meter.ts";

/**
 * A sandbox business (spec §11): the real agent runtime and tools, scheduling on the
 * built-in provider, a mock channel and a mock clock, inside a scratch database. Evals
 * create one per scenario run; the playground one per session. Nothing reaches WhatsApp.
 */

/** Channel tokens in a sandbox are placeholders, so a fixed key is fine. */
const SANDBOX_SECRETS = createSecretBox(Buffer.alloc(32).toString("base64"));
/** The sandbox customer's WhatsApp number (Colombian mobile format). */
export const SANDBOX_WA_NUMBER = "573000000001";
/** Sandboxes never run out of AI budget; spend is reported per turn instead. */
const NO_BUDGET_LIMIT = 1_000_000;

export interface SandboxSpec {
  name: string;
  config: Record<string, unknown>;
  timezone?: string;
  holidays?: HolidaySettings;
  resources: {
    kind: string;
    name: string;
    capacity?: number | null;
    schedule?: WeeklySchedule | null;
  }[];
  /** `resource`: the name of one of `resources`, or null for the whole business. */
  closures?: { resource: string | null; startsAt: Date; endsAt: Date; reason: string | null }[];
  contact: { name?: string | null; fields?: Record<string, unknown>; consentAt: Date | null };
  /** Existing bookings of the sandbox customer (eval `fixtures.bookings`). */
  bookings?: {
    serviceKey: string;
    startsAt: Date;
    subjectName: string;
    status?: "pending" | "confirmed";
  }[];
}

/** Ids of a sandbox's rows: all an agent turn needs, small enough to store. */
export interface Sandbox {
  businessId: string;
  phoneNumberId: string;
  contactId: string;
  conversationId: string;
  waNumber: string;
  timezone: string;
  fixtureBookingIds: string[];
}

/** Stores the template in the scratch database as published (once per database). */
export async function installTemplate(
  db: Database,
  template: Pick<TemplateRow, "slug" | "version" | "sourceYaml">,
): Promise<TemplateRow> {
  const existing = await getTemplateVersion(db, template.slug, template.version);
  if (existing?.status === "published") return existing;
  const { row } = await saveTemplateDraft(db, { sourceYaml: template.sourceYaml });
  return setTemplateStatus(db, row.slug, row.version, "published");
}

/** Creates the business, its channel, resources, closures and customer. */
export async function createSandbox(
  db: Database,
  template: Pick<TemplateRow, "slug" | "version">,
  spec: SandboxSpec,
): Promise<Sandbox> {
  const row = await getTemplateVersion(db, template.slug, template.version);
  if (!row) throw new Error(`${template.slug}@${template.version} is not installed`);
  const business = await createBusiness(db, {
    name: spec.name,
    templateSlug: row.slug,
    templateVersion: row.version,
    config: spec.config,
    ...(spec.timezone ? { timezone: spec.timezone } : {}),
    ...(spec.holidays ? { holidays: spec.holidays } : {}),
  });
  // Unique per database; Meta's ids are numeric.
  const phoneNumberId = String(randomInt(100_000_000, 999_999_999)) + String(randomInt(1e5, 1e6));
  await createChannel(db, SANDBOX_SECRETS, {
    businessId: business.id,
    phoneNumberId,
    wabaId: "1",
    displayPhone: "sandbox",
    accessToken: "sandbox",
  });

  return withTenant(db, business.id, async (tx) => {
    const resourceIds = new Map<string, string>();
    for (const resource of spec.resources) {
      const created = await createResource(tx, { businessId: business.id, ...resource });
      resourceIds.set(resource.name, created.id);
    }
    for (const closure of spec.closures ?? []) {
      await createClosure(tx, {
        businessId: business.id,
        resourceId: closure.resource === null ? null : (resourceIds.get(closure.resource) ?? null),
        startsAt: closure.startsAt,
        endsAt: closure.endsAt,
        reason: closure.reason,
      });
    }
    const contact = await upsertContact(tx, business.id, SANDBOX_WA_NUMBER);
    const { consentAt } = spec.contact;
    await tx
      .update(contacts)
      .set({
        name: spec.contact.name ?? null,
        fields: spec.contact.fields ?? {},
        consentAt,
        consentRequestedAt: consentAt,
        consentSource: consentAt ? "whatsapp" : null,
      })
      .where(eq(contacts.id, contact.id));
    const conversation = await ensureConversation(tx, business.id, contact.id);

    const fixtureBookingIds: string[] = [];
    const config = business.config ?? spec.config;
    for (const booking of spec.bookings ?? []) {
      const { item, durationMin, resourceKind } = bookingFacts(row, config, booking.serviceKey);
      const resourceId = spec.resources.find((r) => r.kind === resourceKind)?.name;
      const id = resourceId === undefined ? undefined : resourceIds.get(resourceId);
      if (!id) throw new Error(`no "${resourceKind}" resource for the fixture booking`);
      const created = await insertBooking(tx, {
        businessId: business.id,
        contactId: contact.id,
        resourceId: id,
        serviceKey: booking.serviceKey,
        serviceName: typeof item.name === "string" ? item.name : booking.serviceKey,
        priceCop: typeof item.price_cop === "number" ? item.price_cop : null,
        subjectName: booking.subjectName,
        partySize: null,
        startsAt: booking.startsAt,
        endsAt: new Date(booking.startsAt.getTime() + durationMin * 60_000),
        source: "staff",
        notes: null,
      });
      if (booking.status !== "pending") {
        await tx
          .update(bookings)
          .set({ status: "confirmed", confirmedAt: booking.startsAt })
          .where(eq(bookings.id, created.id));
      }
      fixtureBookingIds.push(created.id);
    }

    return {
      businessId: business.id,
      phoneNumberId,
      contactId: contact.id,
      conversationId: conversation.id,
      waNumber: SANDBOX_WA_NUMBER,
      timezone: business.timezone,
      fixtureBookingIds,
    };
  });
}

function bookingFacts(
  template: TemplateRow,
  config: Record<string, unknown>,
  serviceKey: string,
): { item: Record<string, unknown>; durationMin: number; resourceKind: string } {
  const section = template.manifest.booking;
  if (!section) throw new Error("the template has no booking section");
  const rules = resolveBookingRules(section, config);
  const catalog = getPath(config, rules.catalog_path);
  const item = Array.isArray(catalog)
    ? (catalog as Record<string, unknown>[]).find((i) => i.key === serviceKey)
    : undefined;
  if (!item) throw new Error(`"${serviceKey}" is not in the catalog`);
  const durationMin =
    rules.duration_from === "fixed" ? Number(rules.fixed_duration_min) : Number(item.duration_min);
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new Error(`"${serviceKey}" has no duration`);
  }
  return { item, durationMin, resourceKind: String(rules.resource_kind) };
}

/**
 * The sandbox of a database that holds exactly one (a playground session's), found again
 * from its rows, so the session needs to store only the database name.
 */
export async function findSandbox(db: Database): Promise<Sandbox> {
  const [business] = await db.select().from(businesses).limit(2);
  if (!business) throw new Error("the sandbox database has no business");
  return withTenant(db, business.id, async (tx) => {
    const [channel] = await tx.select().from(channels).where(eq(channels.businessId, business.id));
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.waNumber, SANDBOX_WA_NUMBER));
    if (!channel || !contact) throw new Error("the sandbox database is incomplete");
    const conversation = await ensureConversation(tx, business.id, contact.id);
    return {
      businessId: business.id,
      phoneNumberId: channel.phoneNumberId,
      contactId: contact.id,
      conversationId: conversation.id,
      waNumber: contact.waNumber,
      timezone: business.timezone,
      fixtureBookingIds: [],
    };
  });
}

// --- one customer turn -----------------------------------------------------------------

export interface SandboxDeps {
  db: Database;
  logger: Logger;
  llm: LlmClient;
  now: () => Date;
  /** False when the LLM replays recorded responses: nothing is spent. */
  billable: boolean;
}

export interface TurnOutcome {
  replies: { body: string; kind: string }[];
  toolCalls: ToolCallLog[];
  usage: TokenUsage;
  costUsd: number;
  models: string[];
  /** Booking events the agent emitted (automations don't run in a sandbox). */
  events: BookingEvent["type"][];
  /** LLM calls that failed (the agent hands off on these; reports must not blame it). */
  llmErrors: unknown[];
  /** Set when the turn itself failed (the message stays unanswered). */
  error: unknown;
}

/**
 * The customer sends `text`: through the real webhook ingest, the inbound batch pipeline
 * and the agent, as the worker would run it, then out through the mock channel.
 */
export async function customerSays(
  deps: SandboxDeps,
  sandbox: Sandbox,
  text: string,
): Promise<TurnOutcome> {
  const at = deps.now();
  const message: InboundMessage = {
    waMessageId: `wamid.sandbox.${randomUUID()}`,
    from: sandbox.waNumber,
    timestamp: at,
    type: "text",
    text,
    button: null,
    interactive: null,
    reaction: null,
    contextMessageId: null,
    profileName: null,
    actionable: true,
    raw: { type: "text", text: { body: text } },
  };
  const jobs: { businessId: string; conversationId: string }[] = [];
  await ingestWebhookEvents(
    {
      db: deps.db,
      logger: deps.logger,
      resolveChannel: (id) =>
        Promise.resolve(id === sandbox.phoneNumberId ? sandbox.businessId : null),
      enqueue: (job) => Promise.resolve(void jobs.push(job)),
    },
    [{ kind: "message", phoneNumberId: sandbox.phoneNumberId, message }],
  );
  const job = jobs[0];
  if (!job) throw new Error("the sandbox message was not stored");

  const llm = meterCalls(deps.llm, { billable: deps.billable });
  const replies: Reply[] = [];
  const events: BookingEvent["type"][] = [];
  const agent = createAgentResponder({
    db: deps.db,
    logger: deps.logger,
    now: deps.now,
    provider: builtinProvider,
    events: { emit: (event) => Promise.resolve(void events.push(event.type)) },
    llm,
    llmBudgetUsdMonth: NO_BUDGET_LIMIT,
  });
  const responder: Responder = async (batch, info) => {
    const out = await agent(batch, info);
    replies.push(...out);
    return out;
  };
  let error: unknown = null;
  try {
    // Not the final attempt: an API failure throws instead of handing off, so it shows up
    // as an error rather than as the agent's choice.
    await processInboundBatch(
      {
        db: deps.db,
        logger: deps.logger,
        whatsapp: captureChannel(),
        secrets: SANDBOX_SECRETS,
        now: deps.now,
        responder,
      },
      job,
      { finalAttempt: false },
    );
  } catch (caught) {
    error = caught;
  }
  return {
    replies: error ? [] : replies.map((r) => ({ body: r.body, kind: r.meta?.kind ?? "agent" })),
    toolCalls: replies.flatMap((r) => (r.meta?.toolCalls ?? []) as ToolCallLog[]),
    usage: llm.usage(),
    costUsd: llm.costUsd(),
    models: llm.models(),
    events,
    llmErrors: llm.errors,
    error,
  };
}

// --- state ------------------------------------------------------------------------------

export interface SandboxBooking {
  id: string;
  serviceKey: string;
  serviceName: string;
  subjectName: string;
  startsAt: string;
  /** Business-local "YYYY-MM-DD" and "HH:mm". */
  localDate: string;
  localTime: string;
  label: string;
  status: string;
  /** Present before the conversation started (eval fixtures). */
  fixture: boolean;
}

export interface SandboxState {
  mode: "bot" | "human";
  consentGiven: boolean;
  optedOut: boolean;
  handoffs: { reason: string; open: boolean; summary: string | null }[];
  bookings: SandboxBooking[];
}

export async function sandboxState(db: Database, sandbox: Sandbox): Promise<SandboxState> {
  return withTenant(db, sandbox.businessId, async (tx) => {
    const [conversation] = await tx
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, sandbox.conversationId));
    const [contact] = await tx
      .select({ consentAt: contacts.consentAt, optedOutAt: contacts.optedOutAt })
      .from(contacts)
      .where(eq(contacts.id, sandbox.contactId));
    const handoffRows = await tx
      .select()
      .from(handoffs)
      .where(eq(handoffs.conversationId, sandbox.conversationId))
      .orderBy(asc(handoffs.openedAt));
    const bookingRows = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.contactId, sandbox.contactId))
      .orderBy(asc(bookings.startsAt));
    return {
      mode: conversation?.mode === "human" ? "human" : "bot",
      consentGiven: Boolean(contact?.consentAt),
      optedOut: Boolean(contact?.optedOutAt),
      handoffs: handoffRows.map((h) => ({
        reason: h.reason,
        open: h.resolvedAt === null,
        summary: h.summary,
      })),
      bookings: bookingRows.map((b) => {
        const local = DateTime.fromJSDate(b.startsAt, { zone: sandbox.timezone });
        return {
          id: b.id,
          serviceKey: b.serviceKey,
          serviceName: b.serviceName,
          subjectName: b.subjectName,
          startsAt: local.toISO({ suppressMilliseconds: true }) ?? "",
          localDate: local.toISODate() ?? "",
          localTime: local.toFormat("HH:mm"),
          label: formatSlotLabel(local),
          status: b.status,
          fixture: sandbox.fixtureBookingIds.includes(b.id),
        };
      }),
    };
  });
}

/** Staff close the handoff: the conversation goes back to the bot (playground). */
export async function returnSandboxToBot(db: Database, sandbox: Sandbox): Promise<void> {
  await withTenant(db, sandbox.businessId, (tx) =>
    resolveHandoff(tx, sandbox.conversationId, null),
  );
}
