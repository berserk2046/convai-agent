import { completeDueBookings, type Database } from "@platform/db";
import type { Logger } from "@platform/shared";
import { Queue, Worker } from "bullmq";
import type { EventSink } from "./agent/tools/types.ts";
import type { QueueConnection } from "./inbound/queue.ts";

/**
 * Periodic platform jobs. Each runs as a BullMQ job scheduler, so exactly one worker runs
 * a given tick even with several workers up. Platform-level (cross-tenant) by design.
 */

export const MAINTENANCE_QUEUE = "maintenance";

/** A periodic job: its BullMQ scheduler name, how often it runs, and what it does. */
export interface MaintenanceJob {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/** Spec §8: booking completion runs every 10 minutes. */
export const COMPLETE_BOOKINGS_EVERY_MS = 10 * 60_000;

/** Spec §8: every 10 minutes, finished bookings become completed. */
export async function completeBookings(deps: {
  db: Database;
  logger: Logger;
  events: EventSink;
  now: () => Date;
}): Promise<number> {
  const at = deps.now();
  const completed = await completeDueBookings(deps.db, at);
  for (const booking of completed) {
    await deps.events.emit({
      type: "booking.completed",
      businessId: booking.businessId,
      bookingId: booking.id,
      at,
    });
  }
  if (completed.length > 0) deps.logger.info({ count: completed.length }, "bookings completed");
  return completed.length;
}

export function createMaintenanceQueue(connection: QueueConnection): Queue {
  return new Queue(MAINTENANCE_QUEUE, {
    connection: { url: connection.redisUrl },
    ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
    defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { age: 7 * 24 * 3600 } },
  });
}

export async function scheduleMaintenance(
  queue: Queue,
  jobs: readonly Pick<MaintenanceJob, "name" | "everyMs">[],
): Promise<void> {
  for (const job of jobs) {
    await queue.upsertJobScheduler(job.name, { every: job.everyMs }, { name: job.name });
  }
}

export function createMaintenanceWorker(
  connection: QueueConnection,
  jobs: readonly MaintenanceJob[],
): Worker {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  return new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      const handler = byName.get(job.name);
      if (!handler) throw new Error(`unknown maintenance job "${job.name}"`);
      return handler.run();
    },
    {
      connection: { url: connection.redisUrl, maxRetriesPerRequest: null },
      ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
      concurrency: 1,
    },
  );
}
