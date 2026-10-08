import {
  createChannelResolver,
  createInboundQueue,
  enqueueInboundBatch,
  ingestWebhookEvents,
} from "@platform/core";
import { createDb } from "@platform/db";
import {
  apiEnv,
  baseEnv,
  createLogger,
  databaseEnv,
  inboundEnv,
  metaEnv,
  parseEnv,
  redisEnv,
} from "@platform/shared";
import { buildApp } from "./app.ts";

const env = parseEnv(
  baseEnv
    .extend(databaseEnv.shape)
    .extend(redisEnv.shape)
    .extend(metaEnv.pick({ META_APP_SECRET: true, META_VERIFY_TOKEN: true }).shape)
    .extend(inboundEnv.pick({ INBOUND_DEBOUNCE_MS: true }).shape)
    .extend(apiEnv.shape),
);
const logger = createLogger({ level: env.LOG_LEVEL, name: "api" });
const database = createDb(env.DATABASE_URL);
database.pool.on("error", (error) => {
  logger.error({ err: error }, "idle Postgres connection failed");
});
const queue = createInboundQueue({ redisUrl: env.REDIS_URL });
const resolveChannel = createChannelResolver(database.db);

const app = buildApp({
  logger,
  meta: { appSecret: env.META_APP_SECRET, verifyToken: env.META_VERIFY_TOKEN },
  ingest: (events) =>
    ingestWebhookEvents(
      {
        db: database.db,
        logger,
        resolveChannel,
        enqueue: (data) => enqueueInboundBatch(queue, data, env.INBOUND_DEBOUNCE_MS),
      },
      events,
    ),
  health: {
    postgres: () => database.pool.query("SELECT 1"),
    // A real Redis round trip through BullMQ's public API.
    redis: () => queue.count(),
  },
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await app.close();
  await queue.close();
  await database.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: env.HOST, port: env.PORT });
