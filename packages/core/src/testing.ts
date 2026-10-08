import { randomBytes } from "node:crypto";
import { createWhatsAppClient } from "@platform/channels";
import { startFakeGraph, type FakeGraph } from "@platform/channels/testing";
import { createChannel, type BusinessRow, type ChannelRow } from "@platform/db";
import { createTestBusiness, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { createLogger, createSecretBox } from "@platform/shared";
import type { CoreDeps } from "./deps.ts";

/** Phone number id of Meta's recorded webhook fixtures. */
export const FIXTURE_PHONE_NUMBER_ID = "106540352242922";

export interface LogLine {
  level: number;
  msg: string;
  alert?: string;
  [key: string]: unknown;
}

export interface CoreHarness {
  testDb: TestDatabase;
  graph: FakeGraph;
  business: BusinessRow;
  channel: ChannelRow;
  deps: CoreDeps;
  logs: LogLine[];
  close(): Promise<void>;
}

/**
 * A migrated throwaway database with one business and a channel on the fixtures' phone
 * number, a fake Graph API, and deps wired to both. Logs are captured for assertions.
 */
export async function createCoreHarness(): Promise<CoreHarness> {
  const testDb = await createTestDatabase();
  const graph = await startFakeGraph();
  const secrets = createSecretBox(randomBytes(32).toString("base64"));
  const business = await createTestBusiness(testDb.db);
  const channel = await createChannel(testDb.db, secrets, {
    businessId: business.id,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    wabaId: "102290129340398",
    displayPhone: "15550783881",
    accessToken: "EAAG-test-token",
  });
  const logs: LogLine[] = [];
  const logger = createLogger(
    { level: "debug" },
    { write: (line: string) => logs.push(JSON.parse(line) as LogLine) },
  );
  const deps: CoreDeps = {
    db: testDb.db,
    logger,
    whatsapp: createWhatsAppClient({ baseUrl: graph.url, graphVersion: "v24.0" }),
    secrets,
    now: () => new Date(),
  };
  return {
    testDb,
    graph,
    business,
    channel,
    deps,
    logs,
    async close() {
      await graph.close();
      await testDb.drop();
    },
  };
}
