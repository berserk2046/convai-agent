import { createWhatsAppClient } from "@platform/channels";
import { INBOX_CHANNEL, createChangeFeed, createDb, type ChangeFeed } from "@platform/db";
import type { ServiceDeps } from "@platform/services";
import { createAnthropicLlm } from "@platform/llm";
import {
  adminEnv,
  agentEnv,
  automationsEnv,
  baseEnv,
  createLogger,
  createSecretBox,
  databaseEnv,
  encryptionEnv,
  metaEnv,
  parseEnv,
} from "@platform/shared";

/**
 * The admin's connection to the service layer: one database pool, WhatsApp client and
 * inbox change feed per server process. Created on first use, so `next build` needs no
 * environment.
 */

const envSchema = baseEnv
  .extend(databaseEnv.shape)
  .extend(encryptionEnv.shape)
  .extend(metaEnv.pick({ META_GRAPH_VERSION: true, META_GRAPH_BASE_URL: true }).shape)
  .extend(automationsEnv.pick({ MARKETING_MSGS_MONTH: true }).shape)
  .extend(adminEnv.shape)
  .extend(agentEnv.pick({ ANTHROPIC_API_KEY: true }).shape);

// Dev reloads re-evaluate modules; one pool per process, not per reload.
const holder = globalThis as {
  __platformAdmin?: { deps: ServiceDeps; production: boolean; inboxFeed: ChangeFeed };
};

function instance() {
  if (!holder.__platformAdmin) {
    const env = parseEnv(envSchema);
    const logger = createLogger({ level: env.LOG_LEVEL, name: "admin" });
    const { db } = createDb(env.DATABASE_URL);
    holder.__platformAdmin = {
      production: env.NODE_ENV === "production",
      // One LISTEN connection, opened when the first inbox tab connects (ADR 0013).
      inboxFeed: createChangeFeed(env.DATABASE_URL, {
        channel: INBOX_CHANNEL,
        onError: (error: unknown) => {
          logger.warn({ err: error }, "inbox change feed lost its connection; retrying");
        },
      }),
      deps: {
        db,
        logger,
        secrets: createSecretBox(env.ENCRYPTION_KEY),
        whatsapp: createWhatsAppClient({
          baseUrl: env.META_GRAPH_BASE_URL,
          graphVersion: env.META_GRAPH_VERSION,
        }),
        now: () => new Date(),
        sessionSecret: env.SESSION_SECRET,
        marketingMsgsMonth: env.MARKETING_MSGS_MONTH,
        // The playground's scratch databases go on this server (ADR 0016).
        playground: {
          databaseUrl: env.DATABASE_URL,
          llm: env.ANTHROPIC_API_KEY ? createAnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY }) : null,
        },
      },
    };
  }
  return holder.__platformAdmin;
}

export function services(): ServiceDeps {
  return instance().deps;
}

/** Committed changes to what the inbox shows, by business. */
export function inboxFeed(): ChangeFeed {
  return instance().inboxFeed;
}

/** Cookies are `Secure` in production (HTTPS behind Caddy), not on local http. */
export function secureCookies(): boolean {
  return instance().production;
}
