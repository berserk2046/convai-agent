import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv, redisEnv } from "@platform/shared";
import type { Queue, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInboundQueue,
  createInboundWorker,
  enqueueInboundBatch,
  type InboundJobData,
} from "./queue.ts";

/**
 * Proves the BullMQ deduplication settings do what queue.ts claims, on real Redis.
 * (Read from BullMQ's Lua; this test keeps us honest across BullMQ upgrades.)
 */

const redisUrl = parseEnv(redisEnv).REDIS_URL;
let queue: Queue<InboundJobData> | undefined;
let worker: Worker<InboundJobData> | undefined;

afterEach(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
});

const data = (conversationId: string) => ({
  businessId: "b1",
  conversationId,
  waNumber: "573000000000",
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

describe("inbound queue deduplication", () => {
  it("debounces: several adds during the delay become one job with the latest data", async () => {
    const connection = { redisUrl, prefix: `test-${randomUUID()}` };
    queue = createInboundQueue(connection);
    const runs: string[] = [];
    worker = createInboundWorker(
      connection,
      (job) => Promise.resolve(runs.push(job.data.conversationId)),
      { concurrency: 5 },
    );

    // A long delay with short gaps keeps this independent of machine load.
    await enqueueInboundBatch(queue, data("first"), 1_500);
    await sleep(50);
    await enqueueInboundBatch(queue, data("second"), 1_500);
    await sleep(50);
    await enqueueInboundBatch(queue, data("third"), 1_500);
    await waitFor(() => runs.length > 0);
    await sleep(500);
    expect(runs).toEqual(["third"]);
  });

  it("never runs a contact's batches in parallel, and catches messages that arrive mid-run", async () => {
    const connection = { redisUrl, prefix: `test-${randomUUID()}` };
    queue = createInboundQueue(connection);
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    let release: () => void = () => undefined;
    const firstRunGate = new Promise<void>((resolve) => (release = resolve));

    worker = createInboundWorker(
      connection,
      async (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        runs.push(job.data.conversationId);
        if (runs.length === 1) await firstRunGate;
        active -= 1;
      },
      { concurrency: 5 },
    );

    await enqueueInboundBatch(queue, data("during-1"), 10);
    await waitFor(() => runs.length === 1);
    // The first run is active: these must turn into exactly one follow-up run.
    await enqueueInboundBatch(queue, data("during-2"), 10);
    await enqueueInboundBatch(queue, data("during-3"), 10);
    await sleep(200);
    expect(runs).toHaveLength(1);

    release();
    await waitFor(() => runs.length === 2);
    await sleep(300);
    expect(runs).toEqual(["during-1", "during-3"]);
    expect(maxActive).toBe(1);
  });
});
