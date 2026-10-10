import { auditLog, listAudit, sessions } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireBusiness, requireOwner } from "./actor.ts";
import {
  changePassword,
  impersonate,
  login,
  logout,
  resolveSession,
  sessionTokenHash,
  stopImpersonating,
  switchBusiness,
} from "./auth.ts";
import { ActionRefusedError, ForbiddenError, NotFoundError } from "./errors.ts";
import { PASSWORD, createHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe("login and sessions", () => {
  it("logs in, stores only the token's HMAC, and resolves the session's business", async () => {
    const actor = await h.actor("admin@a.co", { business: h.a, role: "business_admin" });
    expect(actor.business).toEqual({
      id: h.a.id,
      name: h.a.name,
      timezone: "America/Bogota",
      role: "business_admin",
      impersonating: false,
    });
    const [row] = await h.core.testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, actor.sessionId));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects wrong passwords and unknown emails the same way", async () => {
    await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
    const wrong = await login(h.deps, { email: "staff@a.co", password: "nope", ip: "10.0.0.1" });
    const unknown = await login(h.deps, { email: "ghost@a.co", password: "nope", ip: "10.0.0.1" });
    expect([wrong, unknown]).toEqual([
      { ok: false, reason: "invalid" },
      { ok: false, reason: "invalid" },
    ]);
  });

  it("locks an email out after 5 failures in 15 minutes, even with the right password", async () => {
    await h.actor("target@a.co", { business: h.a });
    for (let i = 0; i < 5; i += 1) {
      await login(h.deps, { email: "Target@A.co", password: "bad", ip: `10.0.1.${i}` });
    }
    const right = await login(h.deps, { email: "target@a.co", password: PASSWORD, ip: "10.0.2.1" });
    expect(right).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("rotates the session on login and ends it on logout", async () => {
    await h.actor("rotate@a.co", { business: h.a });
    const first = await login(h.deps, { email: "rotate@a.co", password: PASSWORD, ip: null });
    if (!first.ok) throw new Error("login failed");
    const second = await login(h.deps, {
      email: "rotate@a.co",
      password: PASSWORD,
      ip: null,
      previousToken: first.token,
    });
    if (!second.ok) throw new Error("login failed");
    expect(await resolveSession(h.deps, first.token)).toBeNull();
    expect(await resolveSession(h.deps, second.token)).not.toBeNull();
    await logout(h.deps, second.token);
    expect(await resolveSession(h.deps, second.token)).toBeNull();
    expect(await resolveSession(h.deps, "forged")).toBeNull();
    expect(sessionTokenHash("k", "t")).not.toBe(sessionTokenHash("other", "t"));
  });

  it("expires sessions after 7 days without use", async () => {
    await h.actor("idle@a.co", { business: h.a });
    const result = await login(h.deps, { email: "idle@a.co", password: PASSWORD, ip: null });
    if (!result.ok) throw new Error("login failed");
    h.setClock(new Date(Date.now() + 8 * 86_400_000));
    expect(await resolveSession(h.deps, result.token)).toBeNull();
    h.setClock(new Date());
  });
});

describe("roles and businesses", () => {
  it("staff can't use admin-only screens; nobody without a business uses business screens", async () => {
    const staff = await h.actor("staff2@a.co", { business: h.a, role: "business_staff" });
    expect(requireBusiness(staff)).toEqual({ businessId: h.a.id, role: "business_staff" });
    expect(() => requireBusiness(staff, ["business_admin"])).toThrow(ForbiddenError);
    expect(() => requireOwner(staff)).toThrow(ForbiddenError);
    const owner = await h.actor("owner@platform.co", { owner: true });
    expect(owner.business).toBeNull();
    expect(() => requireBusiness(owner)).toThrow(ForbiddenError);
  });

  it("switches only to businesses the user belongs to", async () => {
    const admin = await h.actor("multi@a.co", { business: h.a });
    await expect(switchBusiness(h.deps, admin, h.b.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lets the platform owner impersonate a business as its admin, audited", async () => {
    const owner = await h.actor("owner2@platform.co", { owner: true });
    await impersonate(h.deps, owner, h.b.id);
    const result = await login(h.deps, {
      email: "owner2@platform.co",
      password: PASSWORD,
      ip: null,
    });
    if (!result.ok) throw new Error("login failed");
    // A new login starts outside any business.
    expect((await resolveSession(h.deps, result.token))?.business).toBeNull();

    const [session] = await h.core.testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, owner.sessionId));
    expect(session).toMatchObject({ businessId: h.b.id, impersonating: true });
    const audit = await listAudit(h.deps.db, { businessId: h.b.id });
    expect(audit.map((a) => [a.action, a.actorEmail])).toContainEqual([
      "impersonation.start",
      "owner2@platform.co",
    ]);

    await stopImpersonating(h.deps, {
      ...owner,
      business: {
        id: h.b.id,
        name: h.b.name,
        timezone: h.b.timezone,
        role: "business_admin",
        impersonating: true,
      },
    });
    const stops = await h.core.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "impersonation.stop"));
    expect(stops).toHaveLength(1);
  });

  it("only the owner can impersonate", async () => {
    const admin = await h.actor("sneaky@a.co", { business: h.a });
    await expect(impersonate(h.deps, admin, h.b.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("changes a password after checking the current one", async () => {
    const admin = await h.actor("pw@a.co", { business: h.a });
    await expect(
      changePassword(h.deps, admin, { current: "wrong", next: "una contraseña nueva" }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    // A second session (say, a phone where the old password was saved).
    const other = await login(h.deps, { email: "pw@a.co", password: PASSWORD, ip: null });
    if (!other.ok) throw new Error("login failed");

    await changePassword(h.deps, admin, { current: PASSWORD, next: "una contraseña nueva" });
    expect(
      (await login(h.deps, { email: "pw@a.co", password: "una contraseña nueva", ip: null })).ok,
    ).toBe(true);
    // The other session ends; the one that changed the password stays.
    expect(await resolveSession(h.deps, other.token)).toBeNull();
    const [mine] = await h.core.testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, admin.sessionId));
    expect(mine).toBeDefined();
  });
});
