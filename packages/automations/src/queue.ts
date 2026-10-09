import type { QueueConnection } from "@platform/core";
import { Queue, Worker, type Job } from "bullmq";
import type { QueuedRun } from "./deps.ts";

/**
 * The automations queue: one job per run, delayed until the run is due. The job id names
 * the run and its due time, so enqueueing the same run twice is a no-op while the job
 * exists, and a run postponed by quiet hours gets a new job.
 */

export const AUTOMATIONS_QUEUE = "automations";

export interface RunJobData {
  runId: string;
  businessId: string;
}

export function createAutomationsQueue(connection: QueueConnection): Queue<RunJobData> {
  return new Queue<RunJobData>(AUTOMATIONS_QUEUE, {
    connection: { url: connection.redisUrl },
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/** BullMQ job ids can't contain ":" (checked in BullMQ 6.3's source). */
export function runJobId(run: QueuedRun): string {
  return `run-${run.id}-${run.dueAt.getTime()}`;
}

export function runEnqueuer(queue: Queue<RunJobData>, now: () => Date) {
  return async (run: QueuedRun): Promise<void> => {
    await queue.add(
      "run",
      { runId: run.id, businessId: run.businessId },
      { jobId: runJobId(run), delay: Math.max(0, run.dueAt.getTime() - now().getTime()) },
    );
  };
}

export function createAutomationsWorker(
  connection: QueueConnection,
  processor: (job: Job<RunJobData>) => Promise<unknown>,
  options: { concurrency: number },
): Worker<RunJobData> {
  return new Worker<RunJobData>(AUTOMATIONS_QUEUE, processor, {
    connection: { url: connection.redisUrl, maxRetriesPerRequest: null },
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    concurrency: options.concurrency,
  });
}
