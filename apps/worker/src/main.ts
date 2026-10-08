import { createWhatsAppClient } from "@platform/channels";
import {
  completeBookings,
  createAgentResponder,
  createInboundWorker,
  createMaintenanceQueue,
  createMaintenanceWorker,
  echoResponder,
  loggingEventSink,
  processInboundBatch,
  scheduleMaintenance,
  silentResponder,
  type Responder,
} from "@platform/core";
import { createDb } from "@platform/db";
import { createAnthropicLlm } from "@platform/llm";
import { builtinProvider } from "@platform/scheduling";
import { alert, createLogger, createSecretBox } from "@platform/shared";
import { loadWorkerConfig } from "./config.ts";

const env = loadWorkerConfig();
const logger = createLogger({ level: env.LOG_LEVEL, name: "worker" });

const database = createDb(env.DATABASE_URL);
database.pool.on("error", (error) => {
  logger.error({ err: error }, "idle Postgres connection failed");
});
const now = () => new Date();
const events = loggingEventSink(logger);

function responderFor(handler: typeof env.INBOUND_HANDLER): Responder {
  if (handler === "echo") return echoResponder;
  if (handler === "off" || env.ANTHROPIC_API_KEY === undefined) return silentResponder;
  return createAgentResponder({
    db: database.db,
    logger,
    now,
    provider: builtinProvider,
    events,
    llm: createAnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY }),
    llmBudgetUsdMonth: env.LLM_BUDGET_USD_MONTH,
  });
}

const deps = {
  db: database.db,
  logger,
  whatsapp: createWhatsAppClient({
    baseUrl: env.META_GRAPH_BASE_URL,
    graphVersion: env.META_GRAPH_VERSION,
  }),
  secrets: createSecretBox(env.ENCRYPTION_KEY),
  now,
  responder: responderFor(env.INBOUND_HANDLER),
};
const connection = { redisUrl: env.REDIS_URL };

const inbound = createInboundWorker(
  connection,
  (job) =>
    processInboundBatch(deps, job.data, {
      finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    }),
  { concurrency: 5 },
);
inbound.on("failed", (job, error) => {
  const fields = {
    job_id: job?.id,
    business_id: job?.data.businessId,
    conversation_id: job?.data.conversationId,
    err: error,
  };
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    alert(logger, "inbound_job_failed", fields, "inbound batch failed for good");
  } else {
    logger.warn(fields, "inbound batch failed; will retry");
  }
});
inbound.on("error", (error) => {
  logger.error({ err: error }, "inbound worker error");
});

const maintenanceQueue = createMaintenanceQueue(connection);
await scheduleMaintenance(maintenanceQueue);
const maintenance = createMaintenanceWorker(connection, {
  completeBookings: () => completeBookings({ db: database.db, logger, events, now }),
});
maintenance.on("failed", (job, error) => {
  alert(logger, "maintenance_job_failed", { job: job?.name, err: error }, "maintenance job failed");
});

logger.info({ handler: env.INBOUND_HANDLER }, "worker started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await inbound.close();
  await maintenance.close();
  await maintenanceQueue.close();
  await database.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
