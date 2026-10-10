import type { MembershipRole } from "@platform/db";
import { ForbiddenError } from "./errors.ts";

/**
 * Who is acting (spec §12 roles), resolved from the session cookie on every request. The
 * business always comes from the session, never from request input (principle 6).
 */
export interface Actor {
  userId: string;
  email: string;
  name: string;
  isPlatformOwner: boolean;
  sessionId: string;
  /** The business this session works in, if any. */
  business: {
    id: string;
    name: string;
    /** Business screens show times in the business's timezone. */
    timezone: string;
    role: MembershipRole;
    /** The platform owner acting as the business's admin. */
    impersonating: boolean;
  } | null;
  /** Every business the user is a member of (for the switcher). */
  memberships: { businessId: string; businessName: string; role: MembershipRole }[];
}

export function requireOwner(actor: Actor): void {
  if (!actor.isPlatformOwner) throw new ForbiddenError("platform owner screens");
}

/** The session's business, if the actor's role there is one of `roles`. */
export function requireBusiness(
  actor: Actor,
  roles: readonly MembershipRole[] = ["business_admin", "business_staff"],
): { businessId: string; role: MembershipRole } {
  if (!actor.business) throw new ForbiddenError("business screens without a business");
  if (!roles.includes(actor.business.role)) throw new ForbiddenError("this business screen");
  return { businessId: actor.business.id, role: actor.business.role };
}

/** Admins only: setup, automations, reports (staff get inbox and bookings, spec §12). */
export const ADMIN_ONLY: readonly MembershipRole[] = ["business_admin"];
