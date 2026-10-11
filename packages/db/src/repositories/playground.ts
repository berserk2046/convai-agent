import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { playgroundSessions, type PlaygroundSessionRow } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/**
 * Playground sessions (spec §11, ADR 0016): the owner's chats with a template in a scratch
 * database. These rows hold what the admin shows; the scratch database holds agent state.
 */

export interface NewPlaygroundSession {
  ownerUserId: string;
  databaseName: string;
  templateSlug: string;
  templateVersion: string;
  sourceBusinessId: string | null;
  consentGiven: boolean;
  entries: unknown[];
  now: Date;
}

export async function insertPlaygroundSession(
  db: Executor,
  input: NewPlaygroundSession,
): Promise<PlaygroundSessionRow> {
  const [row] = await db
    .insert(playgroundSessions)
    .values({
      ownerUserId: input.ownerUserId,
      databaseName: input.databaseName,
      templateSlug: input.templateSlug,
      templateVersion: input.templateVersion,
      configSource: input.sourceBusinessId ? "business" : "sample_config",
      sourceBusinessId: input.sourceBusinessId,
      consentGiven: input.consentGiven,
      entries: input.entries,
      createdAt: input.now,
      lastUsedAt: input.now,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getPlaygroundSession(
  db: Executor,
  id: string,
): Promise<PlaygroundSessionRow | null> {
  const [row] = await db.select().from(playgroundSessions).where(eq(playgroundSessions.id, id));
  return row ?? null;
}

export type PlaygroundSessionSummaryRow = Omit<PlaygroundSessionRow, "entries"> & {
  entryCount: number;
};

/** Newest first, without the transcripts. */
export async function listPlaygroundSessions(
  db: Executor,
  limit = 50,
): Promise<PlaygroundSessionSummaryRow[]> {
  return db
    .select({
      id: playgroundSessions.id,
      ownerUserId: playgroundSessions.ownerUserId,
      databaseName: playgroundSessions.databaseName,
      templateSlug: playgroundSessions.templateSlug,
      templateVersion: playgroundSessions.templateVersion,
      configSource: playgroundSessions.configSource,
      sourceBusinessId: playgroundSessions.sourceBusinessId,
      consentGiven: playgroundSessions.consentGiven,
      status: playgroundSessions.status,
      costUsd: playgroundSessions.costUsd,
      busySince: playgroundSessions.busySince,
      createdAt: playgroundSessions.createdAt,
      lastUsedAt: playgroundSessions.lastUsedAt,
      closedAt: playgroundSessions.closedAt,
      entryCount: sql<number>`jsonb_array_length(${playgroundSessions.entries})`.mapWith(Number),
    })
    .from(playgroundSessions)
    .orderBy(desc(playgroundSessions.lastUsedAt))
    .limit(limit);
}

/**
 * Claims an active session for one turn. False if it is closed, or still answering a
 * message (a claim older than `staleBefore` is taken over: its process died).
 */
export async function claimPlaygroundTurn(
  db: Executor,
  id: string,
  now: Date,
  staleBefore: Date,
): Promise<boolean> {
  const rows = await db
    .update(playgroundSessions)
    .set({ busySince: now })
    .where(
      and(
        eq(playgroundSessions.id, id),
        eq(playgroundSessions.status, "active"),
        or(isNull(playgroundSessions.busySince), lt(playgroundSessions.busySince, staleBefore)),
      ),
    )
    .returning({ id: playgroundSessions.id });
  return rows.length === 1;
}

/** Appends transcript entries, adds their cost and releases the turn claim. */
export async function appendPlaygroundEntries(
  db: Executor,
  id: string,
  entries: readonly unknown[],
  costUsd: number,
  now: Date,
): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      entries: sql`${playgroundSessions.entries} || ${JSON.stringify(entries)}::jsonb`,
      costUsd: sql`${playgroundSessions.costUsd} + ${costUsd}`,
      lastUsedAt: now,
      busySince: null,
    })
    .where(eq(playgroundSessions.id, id));
}

export async function releasePlaygroundTurn(db: Executor, id: string): Promise<void> {
  await db.update(playgroundSessions).set({ busySince: null }).where(eq(playgroundSessions.id, id));
}

/** Marks a session closed; returns it if it was active (the caller drops its database). */
export async function closePlaygroundSession(
  db: Executor,
  id: string,
  now: Date,
): Promise<PlaygroundSessionRow | null> {
  const [row] = await db
    .update(playgroundSessions)
    .set({ status: "closed", closedAt: now, busySince: null })
    .where(and(eq(playgroundSessions.id, id), eq(playgroundSessions.status, "active")))
    .returning();
  return row ?? null;
}

/** Active sessions nobody used since `idleSince` (the cleanup job closes them). */
export async function listIdlePlaygroundSessions(
  db: Executor,
  idleSince: Date,
): Promise<PlaygroundSessionRow[]> {
  return db
    .select()
    .from(playgroundSessions)
    .where(
      and(eq(playgroundSessions.status, "active"), lt(playgroundSessions.lastUsedAt, idleSince)),
    );
}

/** Database names of active sessions (scratch databases the cleanup must keep). */
export async function activePlaygroundDatabases(db: Executor): Promise<Set<string>> {
  const rows = await db
    .select({ name: playgroundSessions.databaseName })
    .from(playgroundSessions)
    .where(eq(playgroundSessions.status, "active"));
  return new Set(rows.map((r) => r.name));
}

export async function deletePlaygroundSession(db: Executor, id: string): Promise<boolean> {
  const rows = await db
    .delete(playgroundSessions)
    .where(and(eq(playgroundSessions.id, id), eq(playgroundSessions.status, "closed")))
    .returning({ id: playgroundSessions.id });
  return rows.length === 1;
}
