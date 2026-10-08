import {
  parseWebhook,
  verifySubscription,
  verifyWebhookSignature,
  type WebhookEvent,
} from "@platform/channels";
import type { IngestSummary } from "@platform/core";
import type { Logger } from "@platform/shared";
import Fastify, { LogController } from "fastify";

/**
 * HTTP surface (spec §3): WhatsApp webhooks and a health check. A webhook request only
 * verifies, stores, enqueues and returns 200; everything slow happens in the worker.
 */

export interface AppDeps {
  logger: Logger;
  meta: { appSecret: string; verifyToken: string };
  ingest: (events: WebhookEvent[]) => Promise<IngestSummary>;
  /** Each check resolves when healthy and throws otherwise. */
  health: Record<string, () => Promise<unknown>>;
}

/** Meta's webhook payloads can be up to 3 MB (webhooks overview). */
const WEBHOOK_BODY_LIMIT = 4 * 1024 * 1024;

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // The default request log includes the URL, and the verification URL carries our
    // verify token; the routes log what matters themselves.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: WEBHOOK_BODY_LIMIT,
  });

  // Keep the raw bytes: the signature covers the body exactly as Meta sent it.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/webhooks/whatsapp", async (request, reply) => {
    const challenge = verifySubscription(
      request.query as Record<string, unknown>,
      deps.meta.verifyToken,
    );
    if (challenge === null) {
      request.log.warn("webhook verification refused");
      return reply.code(403).send();
    }
    request.log.info("webhook verified");
    return reply.type("text/plain").send(challenge);
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    const raw = request.body;
    const signature = request.headers["x-hub-signature-256"];
    if (
      !Buffer.isBuffer(raw) ||
      !verifyWebhookSignature(
        raw,
        typeof signature === "string" ? signature : undefined,
        deps.meta.appSecret,
      )
    ) {
      request.log.warn("webhook with a missing or bad signature refused");
      return reply.code(401).send();
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      // Signed by Meta but unreadable: retrying won't help, so acknowledge it.
      request.log.error("signed webhook is not valid JSON");
      return reply.code(200).send();
    }
    const parsed = parseWebhook(json);
    if (!parsed.ok) {
      request.log.error({ reason: parsed.error }, "signed webhook has an unexpected shape");
      return reply.code(200).send();
    }

    // If storing fails we answer 500 and Meta re-delivers; storage is idempotent.
    const summary = await deps.ingest(parsed.events);
    request.log.info(summary, "webhook ingested");
    return reply.code(200).send();
  });

  app.get("/health", async (_request, reply) => {
    const results = await Promise.all(
      Object.entries(deps.health).map(async ([name, check]) => {
        try {
          await check();
          return [name, "ok"] as const;
        } catch {
          return [name, "down"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ok = results.every(([, state]) => state === "ok");
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "down", checks });
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;
