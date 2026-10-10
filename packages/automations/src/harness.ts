import { parseWebhook } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import {
  createAgentResponder,
  createChannelResolver,
  ingestWebhookEvents,
  processInboundBatch,
} from "@platform/core";
import { createCoreHarness, type CoreHarness } from "@platform/core/testing";
import { laterVersion, odontologiaAt, publishOdontologia } from "@platform/db/testing";
import {
  activateBusiness,
  applyWaTemplateUpdate,
  bookings,
  businesses,
  contacts,
  createResource,
  ensureConversation,
  grantConsent,
  insertBooking,
  listWaTemplates,
  upsertContact,
  withTenant,
  type BookingRow,
  type ContactRow,
  type ResourceRow,
} from "@platform/db";
import { scriptedLlm, type ScriptStep } from "@platform/llm/testing";
import { builtinProvider } from "@platform/scheduling";
import { eq } from "drizzle-orm";
import { createButtonHandler } from "./buttons.ts";
import type { AutomationDeps, QueuedRun } from "./deps.ts";
import { createAutomationEventSink } from "./events.ts";
import { executeRun, type RunOutcome } from "./execute.ts";
import { sweepAutomations } from "./sweep.ts";

/**
 * Integration test harness: a migrated database with an active odontologia business, its
 * Meta templates approved, a fake Graph API, a mock clock and an in-memory queue. `tick`
 * plays what the worker does every minute: sweep, then run what is due.
 */
export interface Harness {
  core: CoreHarness;
  deps: AutomationDeps;
  chair: ResourceRow;
  /** The mock clock. */
  now: () => Date;
  setClock: (at: Date | string) => void;
  queue: QueuedRun[];
  /** Sweep at `at`, then execute every queued run that is due. */
  tick(at: Date | string): Promise<RunOutcome[]>;
  drain(): Promise<RunOutcome[]>;
  patient(
    waNumber: string,
    options?: { name?: string | null; consent?: boolean },
  ): Promise<ContactRow>;
  book(
    contact: ContactRow,
    startsAt: string,
    options?: { createdAt?: string; serviceKey?: string; minutes?: number },
  ): Promise<BookingRow>;
  /** Names of the templates sent to a number, in order. */
  templatesTo(waNumber: string): string[];
  /** Text messages sent to a number, in order. */
  textsTo(waNumber: string): string[];
  /** A customer message (text or a template button tap) through the real inbound pipeline. */
  receive(
    from: string,
    message: { text: string } | { button: { text: string; payload: string } },
    script?: ScriptStep[],
  ): Promise<{ llmRequests: number; system: string }>;
  close(): Promise<void>;
}

let counter = 0;

/**
 * odontologia with extra rules appended (and their triggers declared), as its next minor
 * version: for triggers the real template doesn't use.
 */
export function odontologiaWith(triggers: string[], rulesYaml: string): string {
  const source = odontologiaAt(laterVersion("minor")).replace(
    "triggers: [booking.starts_in, booking.completed, contact.date_field]",
    `triggers: [booking.starts_in, booking.completed, contact.date_field, ${triggers.join(", ")}]`,
  );
  const at = source.indexOf("\nsample_config:");
  return `${source.slice(0, at)}\n${rulesYaml.trimEnd()}\n${source.slice(at)}`;
}

export async function createHarness(options: { templateSource?: string } = {}): Promise<Harness> {
  const core = await createCoreHarness();
  const db = core.testDb.db;
  if (options.templateSource) {
    // Re-pin the business to a variant of odontologia (e.g. with extra automation rules).
    const variant = await publishOdontologia(db, options.templateSource);
    await db
      .update(businesses)
      .set({ templateVersion: variant.version })
      .where(eq(businesses.id, core.business.id));
  }
  let clock = new Date();
  const queue: QueuedRun[] = [];
  const now = () => clock;
  const enqueue = (run: QueuedRun) => {
    if (!queue.some((q) => q.id === run.id && q.dueAt.getTime() === run.dueAt.getTime())) {
      queue.push(run);
    }
    return Promise.resolve();
  };
  const deps: AutomationDeps = {
    ...core.deps,
    now,
    enqueue,
    marketingMsgsMonth: 500,
    events: createAutomationEventSink({ db, logger: core.deps.logger, now, enqueue }),
    provider: builtinProvider,
  };

  const chair = await createResource(db, {
    businessId: core.business.id,
    kind: "chair",
    name: "S1",
  });
  await activateBusiness(db, core.business.id);
  for (const row of await listWaTemplates(db, core.business.id)) {
    await withTenant(db, core.business.id, (tx) =>
      applyWaTemplateUpdate(
        tx,
        core.business.id,
        { name: row.metaName, language: row.language, metaTemplateId: `meta-${row.metaName}` },
        { status: "APPROVED", category: row.categoryRequested, at: new Date() },
      ),
    );
  }

  async function drain(): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    for (;;) {
      const index = queue.findIndex((r) => r.dueAt.getTime() <= clock.getTime());
      if (index === -1) return outcomes;
      const [run] = queue.splice(index, 1);
      if (run) outcomes.push(await executeRun(deps, { runId: run.id, businessId: run.businessId }));
    }
  }

  const sent = (waNumber: string, type: string) =>
    core.graph.requests.filter((r) => r.body.to === waNumber && r.body.type === type);

  return {
    core,
    deps,
    chair,
    now,
    setClock(at) {
      clock = new Date(at);
    },
    queue,
    async tick(at) {
      clock = new Date(at);
      await sweepAutomations({ db, logger: core.deps.logger, now, enqueue });
      return drain();
    },
    drain,
    async patient(waNumber, options = {}) {
      const contact = await upsertContact(db, core.business.id, waNumber);
      if (options.consent !== false) await grantConsent(db, contact.id, "whatsapp", new Date());
      const name = options.name === undefined ? "Laura Gómez" : options.name;
      const [row] = await db
        .update(contacts)
        .set({ name })
        .where(eq(contacts.id, contact.id))
        .returning();
      await ensureConversation(db, core.business.id, contact.id);
      if (!row) throw new Error("contact missing");
      return row;
    },
    async book(contact, startsAt, options = {}) {
      const start = new Date(startsAt);
      const booking = await insertBooking(db, {
        businessId: core.business.id,
        contactId: contact.id,
        resourceId: chair.id,
        serviceKey: options.serviceKey ?? "limpieza",
        serviceName: options.serviceKey === "valoracion" ? "Valoración" : "Limpieza dental",
        priceCop: 120000,
        subjectName: contact.name ?? "Ana Pérez",
        partySize: null,
        startsAt: start,
        endsAt: new Date(start.getTime() + (options.minutes ?? 45) * 60_000),
        source: "agent",
        notes: null,
      });
      const createdAt = new Date(options.createdAt ?? start.getTime() - 10 * 86_400_000);
      const [row] = await db
        .update(bookings)
        .set({ createdAt })
        .where(eq(bookings.id, booking.id))
        .returning();
      if (!row) throw new Error("booking missing");
      return row;
    },
    templatesTo: (waNumber) =>
      sent(waNumber, "template").map((r) => (r.body.template as { name: string }).name),
    textsTo: (waNumber) =>
      sent(waNumber, "text").map((r) => (r.body.text as { body: string }).body),
    async receive(from, message, script = []) {
      counter += 1;
      const fixture = "text" in message ? "text-message" : "button-message";
      const raw = webhookFixture(fixture) as {
        entry: {
          changes: {
            value: { contacts: { wa_id: string }[]; messages: Record<string, unknown>[] };
          }[];
        }[];
      };
      const value = raw.entry[0]?.changes[0]?.value;
      const inbound = value?.messages[0];
      if (!value || !inbound) throw new Error("fixture shape");
      value.contacts = [{ wa_id: from }];
      inbound.from = from;
      inbound.id = `wamid.automations-${String(counter)}`;
      inbound.timestamp = String(Math.floor(clock.getTime() / 1000));
      if ("text" in message) inbound.text = { body: message.text };
      else inbound.button = message.button;
      const parsed = parseWebhook(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      const jobs: { businessId: string; conversationId: string }[] = [];
      await ingestWebhookEvents(
        {
          db,
          logger: core.deps.logger,
          resolveChannel: createChannelResolver(db),
          enqueue: (d) => Promise.resolve(void jobs.push(d)),
        },
        parsed.events,
      );
      const job = jobs[0];
      if (!job) throw new Error("not enqueued");
      const llm = scriptedLlm(script);
      const responder = createAgentResponder({
        db,
        logger: core.deps.logger,
        now,
        provider: builtinProvider,
        events: deps.events,
        llm,
        llmBudgetUsdMonth: 20,
        buttons: createButtonHandler(deps),
      });
      await processInboundBatch({ ...core.deps, now, responder }, job);
      return {
        llmRequests: llm.requests.length,
        system: JSON.stringify(llm.requests[0]?.system ?? ""),
      };
    },
    close: () => core.close(),
  };
}
