import {
  SWEEP_EVERY_MS,
  TEMPLATE_SYNC_EVERY_MS,
  createAutomationEventSink,
  createAutomationsQueue,
  createAutomationsWorker,
  createButtonHandler,
  executeRun,
  failRun,
  reconcileWaTemplates,
  runEnqueuer,
  sweepAutomations,
  type AutomationDeps,
} from "@platform/automations";
import { createTemplateApi, createWhatsAppClient } from "@platform/channels";
import {
  COMPLETE_BOOKINGS_EVERY_MS,
  completeBookings,
  createAgentResponder,
  createInboundWorker,
  createMaintenanceQueue,
  createMaintenanceWorker,
  echoResponder,
  processInboundBatch,
  scheduleMaintenance,
  silentResponder,
  type MaintenanceJob,
  type Responder,
} from "@platform/core";
import { createDb } from "@platform/db";
import { CLEANUP_EVERY_MS, cleanupSandboxes, startEvalLoop } from "@platform/evals";
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
const connection = { redisUrl: env.REDIS_URL };
const graph = { baseUrl: env.META_GRAPH_BASE_URL, graphVersion: env.META_GRAPH_VERSION };
const secrets = createSecretBox(env.ENCRYPTION_KEY);

// Automations (spec §9): booking events and the sweeper put runs on their own queue.
const automationsQueue = createAutomationsQueue(connection);
const enqueue = runEnqueuer(automationsQueue, now);
const events = createAutomationEventSink({ db: database.db, logger, now, enqueue });
const core = {
  db: database.db,
  logger,
  whatsapp: createWhatsAppClient(graph),
  secrets,
  now,
};
const automationDeps: AutomationDeps = {
  ...core,
  enqueue,
  marketingMsgsMonth: env.MARKETING_MSGS_MONTH,
  events,
  provider: builtinProvider,
};

const llm = env.ANTHROPIC_API_KEY ? createAnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY }) : null;

function responderFor(handler: typeof env.INBOUND_HANDLER): Responder {
  if (handler === "echo") return echoResponder;
  if (handler === "off" || llm === null) return silentResponder;
  return createAgentResponder({
    db: database.db,
    logger,
    now,
    provider: builtinProvider,
    events,
    llm,
    llmBudgetUsdMonth: env.LLM_BUDGET_USD_MONTH,
    buttons: createButtonHandler(automationDeps),
  });
}

const deps = { ...core, responder: responderFor(env.INBOUND_HANDLER) };

const isFinalAttempt = (job: { attemptsMade: number; opts: { attempts?: number } }) =>
  job.attemptsMade >= (job.opts.attempts ?? 1);

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
  if (job && isFinalAttempt(job)) {
    alert(logger, "inbound_job_failed", fields, "inbound batch failed for good");
  } else {
    logger.warn(fields, "inbound batch failed; will retry");
  }
});
inbound.on("error", (error) => {
  logger.error({ err: error }, "inbound worker error");
});

const automations = createAutomationsWorker(
  connection,
  (job) => executeRun(automationDeps, job.data),
  { concurrency: 5 },
);
automations.on("failed", (job, error) => {
  if (job && isFinalAttempt(job)) {
    void failRun(automationDeps, job.data, error).catch((e: unknown) => {
      logger.error({ err: e, run_id: job.data.runId }, "could not mark the run failed");
    });
  } else {
    logger.warn({ run_id: job?.data.runId, err: error }, "automation run failed; will retry");
  }
});
automations.on("error", (error) => {
  logger.error({ err: error }, "automations worker error");
});

const templates = createTemplateApi(graph);
const jobs: MaintenanceJob[] = [
  {
    name: "complete-bookings",
    everyMs: COMPLETE_BOOKINGS_EVERY_MS,
    run: () => completeBookings({ db: database.db, logger, events, now }),
  },
  {
    name: "sweep-automations",
    everyMs: SWEEP_EVERY_MS,
    run: () => sweepAutomations({ db: database.db, logger, now, enqueue }),
  },
  {
    name: "sync-wa-templates",
    everyMs: TEMPLATE_SYNC_EVERY_MS,
    run: () =>
      reconcileWaTemplates({
        db: database.db,
        logger,
        secrets,
        templates,
        now,
        submissionEnabled: env.META_TEMPLATE_SUBMISSION === "on",
      }),
  },
  {
    // Playground sessions idle for a day, and scratch databases nothing uses (ADR 0016).
    name: "cleanup-sandboxes",
    everyMs: CLEANUP_EVERY_MS,
    run: () => cleanupSandboxes({ db: database.db, databaseUrl: env.DATABASE_URL, logger, now }),
  },
];
const maintenanceQueue = createMaintenanceQueue(connection);
await scheduleMaintenance(maintenanceQueue, jobs);
const maintenance = createMaintenanceWorker(connection, jobs);
maintenance.on("failed", (job, error) => {
  alert(logger, "maintenance_job_failed", { job: job?.name, err: error }, "maintenance job failed");
});

// Eval runs the admin queues (spec §11, ADR 0015), one at a time.
const evalLoop = startEvalLoop({
  db: database.db,
  databaseUrl: env.DATABASE_URL,
  logger,
  llm,
  judgeModel: env.JUDGE_MODEL,
  now,
});

logger.info(
  { handler: env.INBOUND_HANDLER, template_submission: env.META_TEMPLATE_SUBMISSION },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await evalLoop.stop();
  await inbound.close();
  await automations.close();
  await maintenance.close();
  await maintenanceQueue.close();
  await automationsQueue.close();
  await database.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
