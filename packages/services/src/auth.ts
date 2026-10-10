import { createHmac, randomBytes } from "node:crypto";
import {
  InvalidInputError,
  createSession,
  createUser,
  deleteSessionByTokenHash,
  deleteUserSessions,
  findSession,
  getBusiness,
  getUser,
  getUserByEmail,
  listUserBusinesses,
  markLoggedIn,
  recentLoginFailures,
  recordAudit,
  recordLoginAttempt,
  setSessionBusiness,
  setUserPassword,
  touchSession,
  type UserRow,
} from "@platform/db";
import type { Actor } from "./actor.ts";
import { requireOwner } from "./actor.ts";
import type { ServiceDeps } from "./deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "./errors.ts";
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from "./password.ts";

/**
 * Logins and sessions (spec §12–13, ADR 0011): email and password (argon2id), database
 * sessions behind an httpOnly cookie, a new session on every login, rate-limited attempts.
 */

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
/** Sliding expiry: a session in use is extended, at most once every 5 minutes. */
const TOUCH_EVERY_MS = 5 * 60_000;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 30;

/** Only the HMAC of a session token is stored; the token itself lives in the cookie. */
export function sessionTokenHash(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export type LoginResult =
  { ok: true; token: string; expiresAt: Date } | { ok: false; reason: "invalid" | "rate_limited" };

export async function login(
  deps: ServiceDeps,
  input: { email: string; password: string; ip: string | null; previousToken?: string | null },
): Promise<LoginResult> {
  const now = deps.now();
  const failures = await recentLoginFailures(deps.db, {
    email: input.email,
    ip: input.ip,
    since: new Date(now.getTime() - LOCKOUT_WINDOW_MS),
  });
  if (failures.email >= MAX_FAILURES_PER_EMAIL || failures.ip >= MAX_FAILURES_PER_IP) {
    deps.logger.warn({ ip: input.ip }, "login rate limited");
    return { ok: false, reason: "rate_limited" };
  }

  const user = await getUserByEmail(deps.db, input.email);
  // An unknown email costs the same time as a wrong password.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  const succeeded = valid && user !== null && user.active;
  await recordLoginAttempt(deps.db, { email: input.email, ip: input.ip, succeeded, at: now });
  if (!succeeded) return { ok: false, reason: "invalid" };

  // Session rotation: whatever session the browser had is replaced.
  if (input.previousToken) await logout(deps, input.previousToken);
  const businesses = await listUserBusinesses(deps.db, user.id);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await createSession(deps.db, {
    tokenHash: sessionTokenHash(deps.sessionSecret, token),
    userId: user.id,
    businessId: user.isPlatformOwner ? null : (businesses[0]?.businessId ?? null),
    expiresAt,
  });
  await markLoggedIn(deps.db, user.id, now);
  deps.logger.info({ user_id: user.id }, "user logged in");
  return { ok: true, token, expiresAt };
}

/** The actor behind a session cookie, or null when there's no live session. */
export async function resolveSession(
  deps: ServiceDeps,
  token: string | null | undefined,
): Promise<Actor | null> {
  if (!token) return null;
  const now = deps.now();
  const found = await findSession(deps.db, sessionTokenHash(deps.sessionSecret, token), now);
  if (!found) return null;
  const { session, user } = found;
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await touchSession(deps.db, session.id, now, new Date(now.getTime() + SESSION_TTL_MS));
  }

  const memberships = await listUserBusinesses(deps.db, user.id);
  let business: Actor["business"] = null;
  if (session.businessId && session.impersonating && user.isPlatformOwner) {
    const row = await getBusiness(deps.db, session.businessId);
    if (row) {
      business = {
        id: row.id,
        name: row.name,
        timezone: row.timezone,
        role: "business_admin",
        impersonating: true,
      };
    }
  } else if (session.businessId) {
    // Still a member? A removed membership ends access right away.
    const membership = memberships.find((m) => m.businessId === session.businessId);
    if (membership) {
      business = {
        id: membership.businessId,
        name: membership.businessName,
        timezone: membership.timezone,
        role: membership.role,
        impersonating: false,
      };
    }
  }
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    isPlatformOwner: user.isPlatformOwner,
    sessionId: session.id,
    business,
    memberships,
  };
}

export async function logout(deps: ServiceDeps, token: string): Promise<void> {
  await deleteSessionByTokenHash(deps.db, sessionTokenHash(deps.sessionSecret, token));
}

/** Works in another of the user's businesses. */
export async function switchBusiness(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
): Promise<void> {
  requireIds("business", businessId);
  if (!actor.memberships.some((m) => m.businessId === businessId)) {
    throw new NotFoundError("business");
  }
  await setSessionBusiness(deps.db, actor.sessionId, businessId, false);
}

/** The platform owner acts as a business's admin (spec §12); audited. */
export async function impersonate(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  const business = await getBusiness(deps.db, businessId);
  if (!business) throw new NotFoundError("business");
  await setSessionBusiness(deps.db, actor.sessionId, business.id, true);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: business.id,
    action: "impersonation.start",
  });
}

export async function stopImpersonating(deps: ServiceDeps, actor: Actor): Promise<void> {
  if (!actor.business?.impersonating) return;
  await setSessionBusiness(deps.db, actor.sessionId, null, false);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: actor.business.id,
    action: "impersonation.stop",
  });
}

export async function changePassword(
  deps: ServiceDeps,
  actor: Actor,
  input: { current: string; next: string },
): Promise<void> {
  const user = await getUser(deps.db, actor.userId);
  if (!user || !(await verifyPassword(input.current, user.passwordHash))) {
    throw new ActionRefusedError("wrong_password", "La contraseña actual no es correcta.");
  }
  const problem = passwordProblem(input.next);
  if (problem) throw new ActionRefusedError("weak_password", problem);
  await setUserPassword(deps.db, user.id, await hashPassword(input.next));
  // Anyone else holding a session (maybe with the old password) is logged out.
  await deleteUserSessions(deps.db, user.id, actor.sessionId);
}

/** Creates a platform owner (`pnpm --filter @platform/services create-owner`). */
export async function createOwner(
  deps: Pick<ServiceDeps, "db">,
  input: { email: string; name: string; password: string },
): Promise<UserRow> {
  const problem = passwordProblem(input.password);
  if (problem) throw new InvalidInputError("user", [{ path: "password", message: problem }]);
  return createUser(deps.db, {
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    isPlatformOwner: true,
  });
}
