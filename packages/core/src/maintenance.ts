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
const COMPLETE_BOOKINGS = "complete-bookings";

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

export async function scheduleMaintenance(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    COMPLETE_BOOKINGS,
    { every: 10 * 60_000 },
    { name: COMPLETE_BOOKINGS },
  );
}

export function createMaintenanceWorker(
  connection: QueueConnection,
  jobs: { completeBookings: () => Promise<unknown> },
): Worker {
  return new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === COMPLETE_BOOKINGS) return jobs.completeBookings();
      throw new Error(`unknown maintenance job "${job.name}"`);
    },
    {
      connection: { url: connection.redisUrl, maxRetriesPerRequest: null },
      ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
      concurrency: 1,
    },
  );
}
