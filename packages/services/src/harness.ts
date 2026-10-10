import { parseWebhook } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import { createChannelResolver, ingestWebhookEvents } from "@platform/core";
import { createCoreHarness, type CoreHarness } from "@platform/core/testing";
import { createUser, setMembership, type BusinessRow, type MembershipRole } from "@platform/db";
import { createTestBusiness } from "@platform/db/testing";
import type { Actor } from "./actor.ts";
import { login, resolveSession } from "./auth.ts";
import type { ServiceDeps } from "./deps.ts";
import { hashPassword } from "./password.ts";

/**
 * Integration test harness: business A (with a WhatsApp channel on the fake Graph API) and
 * business B, a platform owner, and users who log in through the real login.
 */
export interface Harness {
  core: CoreHarness;
  deps: ServiceDeps;
  a: BusinessRow;
  b: BusinessRow;
  setClock(at: Date | string): void;
  /** A customer message to business A through the real webhook ingest; its conversation id. */
  receive(from: string, text: string, at?: Date): Promise<string>;
  /** A user who exists and is logged in, as an Actor. */
  actor(
    email: string,
    options?: { owner?: boolean; business?: BusinessRow; role?: MembershipRole },
  ): Promise<Actor>;
  close(): Promise<void>;
}

export const PASSWORD = "contraseña-de-prueba";

let counter = 0;

export async function createHarness(): Promise<Harness> {
  const core = await createCoreHarness();
  const db = core.testDb.db;
  let clock: Date | null = null;
  const deps: ServiceDeps = {
    db,
    logger: core.deps.logger,
    secrets: core.deps.secrets,
    whatsapp: core.deps.whatsapp,
    now: () => clock ?? new Date(),
    sessionSecret: "test-session-secret-at-least-32-characters",
    marketingMsgsMonth: 500,
  };
  const b = await createTestBusiness(db, "Clínica B");
  const passwordHash = await hashPassword(PASSWORD);

  return {
    core,
    deps,
    a: core.business,
    b,
    setClock(at) {
      clock = new Date(at);
    },
    async receive(from, text, at = new Date()) {
      counter += 1;
      const json = JSON.stringify(webhookFixture("text-message"))
        .replaceAll("16505551234", from)
        .replace("Does it come in another color?", text)
        .replace(/"id":"wamid\.[^"]+"/, `"id":"wamid.services-${String(counter)}"`)
        .replace(/"timestamp":"\d+"/, `"timestamp":"${String(Math.floor(at.getTime() / 1000))}"`);
      const parsed = parseWebhook(JSON.parse(json));
      if (!parsed.ok) throw new Error(parsed.error);
      const jobs: string[] = [];
      await ingestWebhookEvents(
        {
          db,
          logger: core.deps.logger,
          resolveChannel: createChannelResolver(db),
          enqueue: (d) => Promise.resolve(void jobs.push(d.conversationId)),
        },
        parsed.events,
      );
      const conversationId = jobs[0];
      if (!conversationId) throw new Error("not enqueued");
      return conversationId;
    },
    async actor(email, options = {}) {
      const user = await createUser(db, {
        email,
        name: email.split("@")[0] ?? email,
        passwordHash,
        isPlatformOwner: options.owner ?? false,
      });
      if (options.business) {
        await setMembership(db, {
          userId: user.id,
          businessId: options.business.id,
          role: options.role ?? "business_admin",
        });
      }
      const result = await login(deps, { email, password: PASSWORD, ip: "127.0.0.1" });
      if (!result.ok) throw new Error(`login failed: ${result.reason}`);
      const actor = await resolveSession(deps, result.token);
      if (!actor) throw new Error("no session");
      return actor;
    },
    close: () => core.close(),
  };
}
