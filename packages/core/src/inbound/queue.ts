import { Queue, Worker, type Job } from "bullmq";

/**
 * The inbound queue: one job per contact burst. BullMQ deduplication (checked against
 * BullMQ 6.3's own source) gives us both behaviors spec §3 asks for:
 * - `replace` + delay: a new message while the job waits replaces it and restarts the
 *   delay — a trailing debounce, so a burst is answered once;
 * - `keepLastIfActive`: a message arriving while the job runs schedules exactly one
 *   follow-up for when it finishes — never two batches of one contact in parallel, and no
 *   message is left behind.
 */

export const INBOUND_QUEUE = "inbound";

export interface InboundJobData {
  businessId: string;
  conversationId: string;
}

export interface QueueConnection {
  redisUrl: string;
  /** Key prefix; tests use a unique one per run. */
  prefix?: string;
}

export function createInboundQueue(connection: QueueConnection): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE, {
    connection: { url: connection.redisUrl },
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/** Spec §3: jobs are keyed by business and contact number. */
export function inboundDedupId(businessId: string, waNumber: string): string {
  return `${businessId}:${waNumber}`;
}

export async function enqueueInboundBatch(
  queue: Queue<InboundJobData>,
  data: InboundJobData & { waNumber: string },
  debounceMs: number,
): Promise<void> {
  await queue.add(
    "batch",
    { businessId: data.businessId, conversationId: data.conversationId },
    {
      delay: debounceMs,
      deduplication: {
        id: inboundDedupId(data.businessId, data.waNumber),
        replace: true,
        keepLastIfActive: true,
      },
    },
  );
}

export function createInboundWorker(
  connection: QueueConnection,
  processor: (job: Job<InboundJobData>) => Promise<unknown>,
  options: { concurrency: number },
): Worker<InboundJobData> {
  return new Worker<InboundJobData>(INBOUND_QUEUE, processor, {
    // Workers block on Redis; BullMQ requires unlimited retries per request for them.
    connection: { url: connection.redisUrl, maxRetriesPerRequest: null },
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    concurrency: options.concurrency,
  });
}
