import {
  appendPlaygroundEntries,
  businesses,
  claimPlaygroundTurn,
  closePlaygroundSession,
  createDb,
  createScratchDatabase,
  deletePlaygroundSession,
  dropScratchDatabase,
  getBusiness,
  getPlaygroundSession,
  getTemplateVersion,
  insertPlaygroundSession,
  listClosures,
  listPlaygroundSessions,
  listResources,
  preparedTemplateFor,
  recordAudit,
  releasePlaygroundTurn,
  scratchDatabaseName,
  verticalTemplates,
  withDatabaseName,
  withTenant,
  type Database,
  type PlaygroundSessionRow,
  type TemplateRow,
} from "@platform/db";
import {
  captureLogs,
  createSandbox,
  customerSays,
  findSandbox,
  installTemplate,
  returnSandboxToBot,
  sandboxState,
  type LogEntry,
  type SandboxSpec,
  type SandboxState,
} from "@platform/evals";
import type { LlmClient, TokenUsage } from "@platform/llm";
import { formatPath, validateBusinessConfig } from "@platform/templates";
import { asc, ne } from "drizzle-orm";
import { runMigrations } from "@platform/db/migrate";
import { requireOwner, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";

/**
 * /playground (spec §11, ADR 0016): the platform owner chats with a template, using its
 * sample_config or a real business's config, and sees tool calls, tokens and cost per
 * turn. Each session runs the real agent in its own scratch database with a mock
 * channel: nothing reaches WhatsApp, and real bookings and contacts are never touched.
 */

export type PlaygroundEntry =
  | {
      type: "turn";
      at: string;
      user: string;
      replies: { body: string; kind: string }[];
      toolCalls: { name: string; input: unknown; result: unknown; isError: boolean }[];
      usage: TokenUsage;
      costUsd: number;
      models: string[];
      /** Booking events the agent emitted (automations don't run in the playground). */
      events: string[];
      /** The turn failed (e.g. the AI service): the message stays unanswered. */
      error: string | null;
      logs: LogEntry[];
      state: SandboxState;
    }
  | { type: "note"; at: string; text: string; state: SandboxState };

const MAX_MESSAGE_CHARS = 4_096;
/** A turn claim older than this belongs to a request that died. */
const TURN_CLAIM_STALE_MS = 3 * 60_000;

export interface PlaygroundOptions {
  /** Why the playground can't run here, or null. */
  unavailable: string | null;
  templates: { slug: string; version: string; status: string; name: string }[];
  businesses: { id: string; name: string; template: string; configured: boolean }[];
}

export async function playgroundOptions(
  deps: ServiceDeps,
  actor: Actor,
): Promise<PlaygroundOptions> {
  requireOwner(actor);
  const templates = await deps.db
    .select()
    .from(verticalTemplates)
    .where(ne(verticalTemplates.status, "deprecated"))
    .orderBy(asc(verticalTemplates.slug), asc(verticalTemplates.createdAt));
  const rows = await deps.db.select().from(businesses).orderBy(asc(businesses.name));
  return {
    unavailable: unavailableReason(deps),
    templates: templates.map((t) => ({
      slug: t.slug,
      version: t.version,
      status: t.status,
      name: t.manifest.manifest.name,
    })),
    businesses: rows.map((b) => ({
      id: b.id,
      name: b.name,
      template: `${b.templateSlug}@${b.templateVersion}`,
      configured: b.config !== null,
    })),
  };
}

export interface StartPlaygroundInput {
  slug: string;
  version: string;
  /** Use this business's config, resources and closures instead of the sample config. */
  businessId: string | null;
  /** Start as a contact who already accepted the privacy notice. */
  consentGiven: boolean;
}

export async function startPlayground(
  deps: ServiceDeps,
  actor: Actor,
  input: StartPlaygroundInput,
): Promise<{ sessionId: string }> {
  requireOwner(actor);
  const { databaseUrl } = available(deps);
  requireIds("business", input.businessId);
  const template = await getTemplateVersion(deps.db, input.slug, input.version);
  if (!template || template.status === "deprecated") throw new NotFoundError("template");
  const spec = await sandboxSpec(deps, template, input);

  const now = deps.now();
  const name = scratchDatabaseName("play", now);
  const url = await createScratchDatabase(databaseUrl, name);
  let state: SandboxState;
  try {
    state = await withSandboxDb(url, async (db) => {
      const installed = await installTemplate(db, template);
      const sandbox = await createSandbox(db, installed, spec);
      return sandboxState(db, sandbox);
    });
  } catch (error) {
    await dropScratchDatabase(databaseUrl, name);
    throw error;
  }
  const session = await insertPlaygroundSession(deps.db, {
    ownerUserId: actor.userId,
    databaseName: name,
    templateSlug: template.slug,
    templateVersion: template.version,
    sourceBusinessId: input.businessId,
    consentGiven: input.consentGiven,
    entries: [note(now, startText(spec, input), state)],
    now,
  });
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: null,
    action: "playground.start",
    payload: {
      session_id: session.id,
      template: `${template.slug}@${template.version}`,
      business_id: input.businessId,
    },
  });
  return { sessionId: session.id };
}

/** One customer message: the agent's replies, tool calls, tokens and cost become an entry. */
export async function playgroundSay(
  deps: ServiceDeps,
  actor: Actor,
  sessionId: string,
  text: string,
): Promise<void> {
  requireOwner(actor);
  const { databaseUrl, llm } = available(deps);
  const message = text.trim();
  if (message === "") throw new ActionRefusedError("empty", "Write a message first.");
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new ActionRefusedError("too_long", "That message is too long for WhatsApp.");
  }
  const session = await claimTurn(deps, sessionId);
  try {
    const at = deps.now();
    const { logger, entries: logs } = captureLogs();
    const entry = await withSandboxDb(
      withDatabaseName(databaseUrl, session.databaseName),
      async (db) => {
        const sandbox = await findSandbox(db);
        const outcome = await customerSays(
          { db, logger, llm, now: deps.now, billable: true },
          sandbox,
          message,
        );
        const failure = outcome.error ?? outcome.llmErrors[0] ?? null;
        return {
          type: "turn",
          at: at.toISOString(),
          user: message,
          replies: outcome.replies,
          toolCalls: outcome.toolCalls.map((c) => ({
            name: c.name,
            input: c.input,
            result: c.result,
            isError: c.isError,
          })),
          usage: outcome.usage,
          costUsd: outcome.costUsd,
          models: outcome.models,
          events: outcome.events,
          error: failure === null ? null : errorText(failure),
          logs,
          state: await sandboxState(db, sandbox),
        } satisfies PlaygroundEntry;
      },
    );
    await appendPlaygroundEntries(deps.db, sessionId, [entry], entry.costUsd, deps.now());
  } catch (error) {
    await releasePlaygroundTurn(deps.db, sessionId);
    throw error;
  }
}

/** Staff close the open handoff: the bot answers again (principle 7). */
export async function playgroundReturnToBot(
  deps: ServiceDeps,
  actor: Actor,
  sessionId: string,
): Promise<void> {
  requireOwner(actor);
  const { databaseUrl } = available(deps);
  const session = await claimTurn(deps, sessionId);
  try {
    const state = await withSandboxDb(
      withDatabaseName(databaseUrl, session.databaseName),
      async (db) => {
        const sandbox = await findSandbox(db);
        await returnSandboxToBot(db, sandbox);
        return sandboxState(db, sandbox);
      },
    );
    const entry = note(deps.now(), "Staff closed the handoff; the bot answers again.", state);
    await appendPlaygroundEntries(deps.db, sessionId, [entry], 0, deps.now());
  } catch (error) {
    await releasePlaygroundTurn(deps.db, sessionId);
    throw error;
  }
}

/** Ends a session: its scratch database is dropped; the transcript stays readable. */
export async function closePlayground(
  deps: ServiceDeps,
  actor: Actor,
  sessionId: string,
): Promise<void> {
  requireOwner(actor);
  requireIds("playground session", sessionId);
  const closed = await closePlaygroundSession(deps.db, sessionId, deps.now());
  if (!closed) return;
  const databaseUrl = deps.playground?.databaseUrl;
  if (!databaseUrl) return; // The worker's cleanup drops it.
  await dropScratchDatabase(databaseUrl, closed.databaseName).catch((error: unknown) => {
    deps.logger.warn({ err: error, session_id: sessionId }, "playground database not dropped yet");
  });
}

export async function deletePlayground(
  deps: ServiceDeps,
  actor: Actor,
  sessionId: string,
): Promise<void> {
  requireOwner(actor);
  requireIds("playground session", sessionId);
  if (!(await deletePlaygroundSession(deps.db, sessionId))) {
    throw new ActionRefusedError("not_closed", "End the session before deleting it.");
  }
}

export interface PlaygroundSummary {
  id: string;
  template: string;
  config: string;
  status: string;
  messages: number;
  costUsd: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export async function listPlaygrounds(
  deps: ServiceDeps,
  actor: Actor,
): Promise<PlaygroundSummary[]> {
  requireOwner(actor);
  const sessions = await listPlaygroundSessions(deps.db);
  const names = await businessNames(deps);
  return sessions.map((s) => ({
    id: s.id,
    template: `${s.templateSlug}@${s.templateVersion}`,
    config: configLabel(s, names),
    status: s.status,
    // The opening note isn't a message.
    messages: Math.max(0, s.entryCount - 1),
    costUsd: s.costUsd,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
  }));
}

export interface PlaygroundDetail extends PlaygroundSummary {
  busy: boolean;
  consentGiven: boolean;
  entries: PlaygroundEntry[];
  /** The sandbox after the latest entry. */
  state: SandboxState | null;
}

export async function playgroundDetail(
  deps: ServiceDeps,
  actor: Actor,
  sessionId: string,
): Promise<PlaygroundDetail> {
  requireOwner(actor);
  requireIds("playground session", sessionId);
  const session = await getPlaygroundSession(deps.db, sessionId);
  if (!session) throw new NotFoundError("playground session");
  const entries = session.entries as PlaygroundEntry[];
  return {
    id: session.id,
    template: `${session.templateSlug}@${session.templateVersion}`,
    config: configLabel(session, await businessNames(deps)),
    status: session.status,
    messages: entries.filter((e) => e.type === "turn").length,
    costUsd: session.costUsd,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    busy: session.busySince !== null,
    consentGiven: session.consentGiven,
    entries,
    state: entries.at(-1)?.state ?? null,
  };
}

// --- helpers -------------------------------------------------------------------------------

function unavailableReason(deps: ServiceDeps): string | null {
  if (!deps.playground) return "The playground isn't configured in this admin.";
  if (!deps.playground.llm) return "Set ANTHROPIC_API_KEY for the admin to use the playground.";
  return null;
}

function available(deps: ServiceDeps): { databaseUrl: string; llm: LlmClient } {
  const reason = unavailableReason(deps);
  const llm = deps.playground?.llm;
  if (reason || !deps.playground || !llm) {
    throw new ActionRefusedError("playground_off", reason ?? "The playground is off.");
  }
  return { databaseUrl: deps.playground.databaseUrl, llm };
}

async function claimTurn(deps: ServiceDeps, sessionId: string): Promise<PlaygroundSessionRow> {
  requireIds("playground session", sessionId);
  const now = deps.now();
  const claimed = await claimPlaygroundTurn(
    deps.db,
    sessionId,
    now,
    new Date(now.getTime() - TURN_CLAIM_STALE_MS),
  );
  const session = await getPlaygroundSession(deps.db, sessionId);
  if (!session) throw new NotFoundError("playground session");
  if (!claimed) {
    throw new ActionRefusedError(
      session.status === "active" ? "busy" : "closed",
      session.status === "active"
        ? "Still answering the previous message."
        : "This session has ended. Start a new one.",
    );
  }
  return session;
}

async function sandboxSpec(
  deps: ServiceDeps,
  template: TemplateRow,
  input: StartPlaygroundInput,
): Promise<SandboxSpec> {
  const manifest = template.manifest;
  const contact = { consentAt: input.consentGiven ? deps.now() : null };
  if (!input.businessId) {
    return {
      name: `Playground: ${manifest.manifest.name}`,
      config: manifest.sample_config,
      resources: (manifest.eval_fixtures?.resources ?? []).map((r) => ({
        kind: r.kind,
        name: r.name,
        capacity: r.capacity ?? null,
      })),
      contact,
    };
  }
  const business = await getBusiness(deps.db, input.businessId);
  if (!business) throw new NotFoundError("business");
  if (!business.config) {
    throw new ActionRefusedError("not_configured", `${business.name} has no setup data yet.`);
  }
  // The business's config must fit the chosen version (e.g. trying an upgrade first).
  const check = validateBusinessConfig(preparedTemplateFor(template), business.config);
  if (!check.ok) {
    const first = check.issues
      .slice(0, 3)
      .map((i) => `${formatPath(i.path) || "(config)"} ${i.message}`)
      .join("; ");
    throw new ActionRefusedError(
      "config_mismatch",
      `${business.name}'s config doesn't fit ${template.slug}@${template.version}: ${first}`,
    );
  }
  const now = deps.now();
  const { resources, closures } = await withTenant(deps.db, business.id, async (tx) => ({
    resources: (await listResources(tx, business.id)).filter((r) => r.active),
    closures: await listClosures(tx, business.id, now, new Date(now.getTime() + 366 * 86_400_000)),
  }));
  const names = new Map(resources.map((r) => [r.id, r.name]));
  return {
    name: business.name,
    config: check.value,
    timezone: business.timezone,
    holidays: business.holidays,
    resources: resources.map((r) => ({
      kind: r.kind,
      name: r.name,
      capacity: r.capacity,
      schedule: r.schedule,
    })),
    closures: closures.map((c) => ({
      resource: c.resourceId === null ? null : (names.get(c.resourceId) ?? null),
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      reason: c.reason,
    })),
    contact,
  };
}

/** A scratch database for one request: migrated (a deploy may have added migrations), then closed. */
async function withSandboxDb<T>(url: string, work: (db: Database) => Promise<T>): Promise<T> {
  await runMigrations(url);
  const handle = createDb(url, { maxConnections: 3 });
  try {
    return await work(handle.db);
  } finally {
    await handle.close();
  }
}

function note(at: Date, text: string, state: SandboxState): PlaygroundEntry {
  return { type: "note", at: at.toISOString(), text, state };
}

function startText(spec: SandboxSpec, input: StartPlaygroundInput): string {
  const source = input.businessId ? `${spec.name}'s config` : "the template's sample config";
  const resources = spec.resources.map((r) => r.name).join(", ") || "none";
  const consent = input.consentGiven ? "has accepted" : "has not accepted";
  return `Sandbox ready with ${source}. Resources: ${resources}. The customer ${consent} the privacy notice. No bookings yet; automatic messages don't run here.`;
}

async function businessNames(deps: ServiceDeps): Promise<Map<string, string>> {
  const rows = await deps.db.select({ id: businesses.id, name: businesses.name }).from(businesses);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function configLabel(
  session: Pick<PlaygroundSessionRow, "sourceBusinessId">,
  names: ReadonlyMap<string, string>,
): string {
  if (!session.sourceBusinessId) return "Sample config";
  return names.get(session.sourceBusinessId) ?? "A business";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
