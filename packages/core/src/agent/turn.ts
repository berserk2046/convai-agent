import {
  getBusiness,
  getTemplateVersion,
  listContactBookings,
  listOpenProposals,
  listRecentMessages,
  preparedTemplateFor,
  withTenant,
  type BookingRow,
  type BusinessRow,
  type Database,
  type MessageRow,
} from "@platform/db";
import type { SchedulingProvider } from "@platform/scheduling";
import { formatSlotLabel, type Logger } from "@platform/shared";
import {
  TemplateRenderer,
  agentSettings,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  renderDynamicBlock,
  renderSystemBlock,
  resolveBookingRules,
  tidy,
  type BookingFacts,
  type Context,
  type PreparedTemplate,
  type Template,
} from "@platform/templates";
import { DateTime } from "luxon";
import type { InboundBatch } from "../inbound/process.ts";
import type { EventSink, ToolContext } from "./tools/types.ts";

/** Everything one agent turn works with, loaded once per batch. */
export interface Turn {
  tool: ToolContext;
  template: Template;
  /** Variables for replies and the dynamic context (spec §10 conversation context). */
  context: Context;
  systemBlock: string;
  recent: Awaited<ReturnType<typeof listRecentMessages>>;
}

export interface TurnDeps {
  db: Database;
  logger: Logger;
  now: () => Date;
  provider: SchedulingProvider;
  events: EventSink;
}

const renderer = new TemplateRenderer();

/** Renders template text for a reply (consent, emergency, handoff…), tidied. */
export function renderReply(source: string, context: Context): string {
  return tidy(renderer.render(source, context));
}

/** Loads the turn, or null when the business can't answer (paused or not configured). */
export async function loadTurn(deps: TurnDeps, batch: InboundBatch): Promise<Turn | null> {
  const now = deps.now();
  const loaded = await withTenant(deps.db, batch.businessId, async (tx) => {
    const business = await getBusiness(tx, batch.businessId);
    const template = business
      ? await getTemplateVersion(tx, business.templateSlug, business.templateVersion)
      : null;
    if (!business || !template) return null;
    const history = template.manifest.agent.history_messages;
    return {
      business,
      template,
      bookings: await listContactBookings(tx, batch.contact.id, { from: now }),
      recent: await listRecentMessages(tx, batch.conversation.id, history + batch.messages.length),
    };
  });
  if (!loaded) return null;
  const { business, template: row } = loaded;
  if (business.status === "paused" || business.config === null) {
    deps.logger.warn(
      { business_id: business.id, status: business.status },
      "business can't answer yet (paused or not configured)",
    );
    return null;
  }

  const prepared = preparedTemplateFor(row);
  const template = prepared.template;
  const config = business.config;
  const rules = template.booking ? resolveBookingRules(template.booking, config) : null;
  const businessContext = buildBusinessContext(config, prepared.config.schema, business.timezone);
  const contact = batch.contact;
  const context: Context = {
    business: businessContext,
    agent: agentSettings(template),
    now: buildNowContext(
      DateTime.fromJSDate(now, { zone: business.timezone }),
      business.holidays.open_holidays,
    ),
    contact: buildContactContext(
      {
        name: contact.name,
        fields: contact.fields,
        upcomingBookings: loaded.bookings.map((b) => bookingFacts(b, business)),
      },
      Object.keys(template.contact_fields ?? {}),
    ),
  };
  if (rules) context.booking = rules;

  return {
    template,
    context,
    systemBlock: renderSystemBlock(renderer, template, businessContext, rules),
    recent: loaded.recent,
    tool: {
      db: deps.db,
      logger: deps.logger,
      business,
      config,
      prepared,
      timezone: business.timezone,
      rules,
      conversation: batch.conversation,
      contact,
      consentGiven: contact.consentAt !== null,
      turnId: batch.messages.at(-1)?.id ?? "",
      batchMessageIds: new Set(batch.messages.map((m) => m.id)),
      now,
      provider: deps.provider,
      events: deps.events,
    },
  };
}

/** System block 2: the dynamic context plus runtime notes (English, for the model only). */
export async function dynamicBlock(turn: Turn, notes: readonly string[]): Promise<string> {
  const proposals = await withTenant(turn.tool.db, turn.tool.business.id, (tx) =>
    listOpenProposals(tx, turn.tool.conversation.id, turn.tool.now),
  );
  const pending = proposals.map(
    (p) =>
      `- proposal_id ${p.id}: ${p.action} ${describeParams(p.params, turn.tool.business.timezone)}`,
  );
  const earlier = earlierToolCalls(turn.recent);
  const all = [
    ...notes,
    ...(pending.length > 0
      ? [`Waiting for the customer's confirmation of:\n${pending.join("\n")}`]
      : []),
    ...(earlier.length > 0
      ? [
          "Tools you already used earlier in this conversation, with their real results (your earlier " +
            `replies were based on them):\n${earlier.join("\n")}`,
        ]
      : []),
  ];
  const dynamic = renderDynamicBlock(renderer, turn.template, turn.context);
  return all.length > 0 ? `${dynamic}\n\n[Runtime notes]\n${all.join("\n")}` : dynamic;
}

/** Most recent tool calls shown to the model, and the length each one is clipped to. */
const EARLIER_CALLS = 6;
const EARLIER_CALL_CHARS = 500;
/** Guidance the tools gave for that moment, not results: left out of the recap. */
const GUIDANCE_KEYS = new Set(["note", "next_step"]);

/**
 * History is text only (ADR 0008), so without this the model sees its earlier answers but
 * not the checks behind them, and "corrects" itself for answering without checking
 * (owner, 2026-10-11). The calls are stored with each agent reply (`messages.tool_calls`).
 */
export function earlierToolCalls(recent: readonly MessageRow[]): string[] {
  const calls = recent
    .filter((m) => m.direction === "outbound" && Array.isArray(m.toolCalls))
    .flatMap((m) => m.toolCalls as { name?: unknown; input?: unknown; result?: unknown }[]);
  return calls.slice(-EARLIER_CALLS).map((call) => {
    const result = JSON.stringify(call.result, (key, value: unknown) =>
      GUIDANCE_KEYS.has(key) ? undefined : value,
    );
    const line = `- ${String(call.name)} ${JSON.stringify(call.input)} → ${result}`;
    return line.length > EARLIER_CALL_CHARS ? `${line.slice(0, EARLIER_CALL_CHARS - 1)}…` : line;
  });
}

function describeParams(params: Record<string, unknown>, timezone: string): string {
  const when = [params.starts_at, params.new_starts_at].find(
    (v): v is string => typeof v === "string",
  );
  const label = when ? formatSlotLabel(DateTime.fromISO(when, { zone: timezone })) : null;
  return [
    params.service_key,
    label,
    params.subject_name,
    typeof params.booking_id === "string" ? `booking ${params.booking_id}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function bookingFacts(booking: BookingRow, business: BusinessRow): BookingFacts {
  const zone = business.timezone;
  return {
    id: booking.id,
    service_key: booking.serviceKey,
    service_name: booking.serviceName,
    subject_name: booking.subjectName,
    party_size: booking.partySize,
    status: booking.status,
    source: booking.source,
    starts_at: DateTime.fromJSDate(booking.startsAt, { zone }),
    ends_at: DateTime.fromJSDate(booking.endsAt, { zone }),
    resource_name: null,
    notes: booking.notes,
  };
}

export type { PreparedTemplate };
