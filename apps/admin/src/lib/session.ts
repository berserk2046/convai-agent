import { SESSION_COOKIE, resolveSession, type Actor } from "@platform/services";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { services } from "./server.ts";

/**
 * The data access layer's front door (Next's auth guide): every page and every server
 * action resolves the actor from the session cookie here and checks its role. Layouts
 * don't count as a check. Services then scope everything to the actor's business.
 */

/** The logged-in actor for this request (memoized per render), or null. */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveSession(services(), token);
});

export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}

/** Platform-owner screens: anyone else gets a 404 (they don't learn the screen exists). */
export async function requireOwnerPage(): Promise<Actor> {
  const actor = await requireActor();
  if (!actor.isPlatformOwner) notFound();
  return actor;
}

/** Business screens; `adminOnly` for setup, automations and reports (spec §12). */
export async function requireBusinessPage(options: { adminOnly?: boolean } = {}): Promise<Actor> {
  const actor = await requireActor();
  if (!actor.business) redirect("/");
  if (options.adminOnly && actor.business.role !== "business_admin") notFound();
  return actor;
}

/**
 * The client's address for login rate limiting. Caddy (the only way in, M7) sets
 * X-Forwarded-For; the first entry is the client.
 */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}
