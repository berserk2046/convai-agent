import { startFakeGraph } from "@platform/channels/testing";
import { E2E } from "./env.ts";

/** Meta's Graph API stand-in for the admin under test; runs until Playwright stops it. */
const graph = await startFakeGraph({ port: E2E.graphPort });
console.log(`fake Graph API on ${graph.url}`);
