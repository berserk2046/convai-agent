import {
  activePlaygroundDatabases,
  closePlaygroundSession,
  dropScratchDatabase,
  listIdlePlaygroundSessions,
  listScratchDatabases,
  scratchCreatedAt,
  type Database,
} from "@platform/db";
import type { Logger } from "@platform/shared";

/**
 * Hourly worker job (ADR 0016): closes playground sessions nobody used for a day and drops
 * scratch databases that nothing uses any more: a crashed eval run's, or a session's whose
 * close didn't get to drop it. Test databases are left alone (tests drop their own).
 */

export const CLEANUP_EVERY_MS = 60 * 60_000;
const PLAYGROUND_IDLE_MS = 24 * 60 * 60_000;
/** Eval runs take minutes; an eval database this old was left behind. */
const EVAL_DATABASE_MAX_AGE_MS = 6 * 60 * 60_000;
/** Grace for a playground database whose session row isn't committed yet. */
const ORPHAN_GRACE_MS = 60 * 60_000;

export interface CleanupDeps {
  db: Database;
  databaseUrl: string;
  logger: Logger;
  now: () => Date;
}

export async function cleanupSandboxes(
  deps: CleanupDeps,
): Promise<{ closedSessions: number; droppedDatabases: number }> {
  const now = deps.now().getTime();
  let closedSessions = 0;
  for (const session of await listIdlePlaygroundSessions(
    deps.db,
    new Date(now - PLAYGROUND_IDLE_MS),
  )) {
    if (await closePlaygroundSession(deps.db, session.id, deps.now())) closedSessions += 1;
  }

  const keep = await activePlaygroundDatabases(deps.db);
  const old = (name: string, maxAgeMs: number) => {
    const created = scratchCreatedAt(name);
    return created !== null && now - created.getTime() > maxAgeMs;
  };
  const drop = [
    ...(await listScratchDatabases(deps.databaseUrl, "play")).filter(
      (name) => !keep.has(name) && old(name, ORPHAN_GRACE_MS),
    ),
    ...(await listScratchDatabases(deps.databaseUrl, "eval")).filter((name) =>
      old(name, EVAL_DATABASE_MAX_AGE_MS),
    ),
  ];
  for (const name of drop) await dropScratchDatabase(deps.databaseUrl, name);
  if (closedSessions > 0 || drop.length > 0) {
    deps.logger.info(
      { closed_sessions: closedSessions, dropped_databases: drop.length },
      "sandbox cleanup",
    );
  }
  return { closedSessions, droppedDatabases: drop.length };
}
