import { and, asc, count, eq, gt, ne, sql } from "drizzle-orm";
import { InvalidInputError, pgErrorCode } from "../errors.ts";
import {
  auditLog,
  businesses,
  loginAttempts,
  memberships,
  sessions,
  users,
  type AuditRow,
  type MembershipRole,
  type SessionRow,
  type UserRow,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/**
 * Users, memberships, sessions and login attempts (ADR 0011). Platform-level: these run as
 * the owner role, before (or outside) any tenant scope. Callers authorize first.
 */

const UNIQUE_VIOLATION = "23505";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// --- users -------------------------------------------------------------------------------------

export async function createUser(
  db: Executor,
  input: { email: string; name: string; passwordHash: string; isPlatformOwner?: boolean },
): Promise<UserRow> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: normalizeEmail(input.email),
        name: input.name.trim(),
        passwordHash: input.passwordHash,
        isPlatformOwner: input.isPlatformOwner ?? false,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      throw new InvalidInputError("user", [{ path: "email", message: "is already registered" }]);
    }
    throw error;
  }
}

export async function getUser(db: Executor, userId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}

export async function getUserByEmail(db: Executor, email: string): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  return row ?? null;
}

export async function setUserPassword(
  db: Executor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function setUserActive(db: Executor, userId: string, active: boolean): Promise<void> {
  await db.update(users).set({ active }).where(eq(users.id, userId));
}

export async function markLoggedIn(db: Executor, userId: string, at: Date): Promise<void> {
  await db.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId));
}

// --- memberships ---------------------------------------------------------------------------------

/** Adds the user to the business, or changes their role there. */
export async function setMembership(
  db: Executor,
  input: { userId: string; businessId: string; role: MembershipRole },
): Promise<void> {
  await db
    .insert(memberships)
    .values(input)
    .onConflictDoUpdate({
      target: [memberships.userId, memberships.businessId],
      set: { role: input.role },
    });
}

export async function removeMembership(
  db: Executor,
  userId: string,
  businessId: string,
): Promise<void> {
  await db
    .delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessId)));
}

export interface UserBusiness {
  businessId: string;
  businessName: string;
  timezone: string;
  role: MembershipRole;
}

/** The businesses a user works for, by name. */
export async function listUserBusinesses(db: Executor, userId: string): Promise<UserBusiness[]> {
  return db
    .select({
      businessId: memberships.businessId,
      businessName: businesses.name,
      timezone: businesses.timezone,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(businesses.name));
}

export interface BusinessUser {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  active: boolean;
  lastLoginAt: Date | null;
}

export async function listBusinessUsers(db: Executor, businessId: string): Promise<BusinessUser[]> {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.businessId, businessId))
    .orderBy(asc(users.name));
}

// --- sessions ------------------------------------------------------------------------------------

export async function createSession(
  db: Executor,
  input: {
    tokenHash: string;
    userId: string;
    businessId: string | null;
    impersonating?: boolean;
    expiresAt: Date;
  },
): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({ ...input, impersonating: input.impersonating ?? false })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** A live session and its user (active users only). */
export async function findSession(
  db: Executor,
  tokenHash: string,
  now: Date,
): Promise<{ session: SessionRow; user: UserRow } | null> {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), eq(users.active, true)),
    );
  return row ?? null;
}

export async function touchSession(
  db: Executor,
  sessionId: string,
  at: Date,
  expiresAt: Date,
): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: at, expiresAt }).where(eq(sessions.id, sessionId));
}

export async function setSessionBusiness(
  db: Executor,
  sessionId: string,
  businessId: string | null,
  impersonating: boolean,
): Promise<void> {
  await db.update(sessions).set({ businessId, impersonating }).where(eq(sessions.id, sessionId));
}

export async function deleteSessionByTokenHash(db: Executor, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function deleteSession(db: Executor, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Ends a user's sessions, except `keep` (the one changing its own password). */
export async function deleteUserSessions(
  db: Executor,
  userId: string,
  keep: string | null = null,
): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), keep ? ne(sessions.id, keep) : undefined));
}

// --- login attempts (rate limiting) ---------------------------------------------------------------

export async function recordLoginAttempt(
  db: Executor,
  input: { email: string; ip: string | null; succeeded: boolean; at: Date },
): Promise<void> {
  await db.insert(loginAttempts).values({ ...input, email: normalizeEmail(input.email) });
}

/**
 * Failed attempts since `since`, for an email (counted after its last success) and for an
 * IP address.
 */
export async function recentLoginFailures(
  db: Executor,
  input: { email: string; ip: string | null; since: Date },
): Promise<{ email: number; ip: number }> {
  const email = normalizeEmail(input.email);
  const lastSuccess = sql`coalesce((select max(${loginAttempts.at}) from ${loginAttempts}
    where ${loginAttempts.email} = ${email} and ${loginAttempts.succeeded}), '-infinity')`;
  const [byEmail] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.at, input.since),
        sql`${loginAttempts.at} > ${lastSuccess}`,
      ),
    );
  const [byIp] =
    input.ip === null
      ? [{ n: 0 }]
      : await db
          .select({ n: count() })
          .from(loginAttempts)
          .where(
            and(
              eq(loginAttempts.ip, input.ip),
              eq(loginAttempts.succeeded, false),
              gt(loginAttempts.at, input.since),
            ),
          );
  return { email: byEmail?.n ?? 0, ip: byIp?.n ?? 0 };
}

// --- audit log (spec §13) ----------------------------------------------------------------------------

export async function recordAudit(
  db: Executor,
  input: {
    actorUserId: string | null;
    businessId: string | null;
    action: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({ ...input, payload: input.payload ?? {} });
}

export async function listAudit(
  db: Executor,
  filter: { businessId: string | null; limit?: number },
): Promise<(AuditRow & { actorEmail: string | null })[]> {
  const rows = await db
    .select({ entry: auditLog, actorEmail: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      filter.businessId === null
        ? sql`${auditLog.businessId} is null`
        : eq(auditLog.businessId, filter.businessId),
    )
    .orderBy(sql`${auditLog.at} desc`)
    .limit(filter.limit ?? 50);
  return rows.map((r) => ({ ...r.entry, actorEmail: r.actorEmail }));
}
