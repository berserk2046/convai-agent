import { createWhatsAppClient, parseWebhook } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import {
  createAgentResponder,
  createChannelResolver,
  ingestWebhookEvents,
  processInboundBatch,
  type CoreDeps,
} from "@platform/core";
import { createDb, getConversation, grantConsent } from "@platform/db";
import { scriptedLlm, type ScriptStep, type ScriptedLlm } from "@platform/llm/testing";
import { builtinProvider } from "@platform/scheduling";
import { createLogger, createSecretBox } from "@platform/shared";

/**
 * A WhatsApp customer for the smoke test: their message goes through the real webhook
 * ingest and the real agent pipeline (the worker's code path), with a scripted LLM in
 * place of Claude and the fake Graph API in place of Meta. Same database and keys as the
 * admin under test (e2e/env.ts, set by playwright.config.ts).
 */

const env = process.env;
const { db, close } = createDb(env.DATABASE_URL ?? "");
const deps: CoreDeps = {
  db,
  // "fatal": the emergency handoff logs an alert at error level, which is expected here.
  logger: createLogger({ level: "fatal", name: "e2e-customer" }),
  whatsapp: createWhatsAppClient({
    baseUrl: env.META_GRAPH_BASE_URL ?? "",
    graphVersion: env.META_GRAPH_VERSION ?? "",
  }),
  secrets: createSecretBox(env.ENCRYPTION_KEY ?? ""),
  now: () => new Date(),
};

let counter = 0;

export async function customerSays(
  from: string,
  text: string,
  steps: ScriptStep[],
): Promise<{ conversationId: string; llm: ScriptedLlm }> {
  counter += 1;
  const json = JSON.stringify(webhookFixture("text-message"))
    .replaceAll("16505551234", from)
    .replace("Does it come in another color?", text)
    .replace(/"id":"wamid\.[^"]+"/, `"id":"wamid.e2e-${String(Date.now())}-${String(counter)}"`)
    .replace(/"timestamp":"\d+"/, `"timestamp":"${String(Math.floor(Date.now() / 1000))}"`);
  const parsed = parseWebhook(JSON.parse(json));
  if (!parsed.ok) throw new Error(parsed.error);
  const jobs: { businessId: string; conversationId: string }[] = [];
  await ingestWebhookEvents(
    {
      db,
      logger: deps.logger,
      resolveChannel: createChannelResolver(db),
      enqueue: (job) => Promise.resolve(void jobs.push(job)),
    },
    parsed.events,
  );
  const job = jobs[0];
  if (!job) throw new Error("the webhook was not enqueued (is the channel connected?)");

  // The consent exchange is covered by the agent's own tests; here the person has agreed.
  const conversation = await getConversation(db, job.conversationId);
  if (conversation) await grantConsent(db, conversation.contactId, "whatsapp", new Date());

  const llm = scriptedLlm(steps);
  const responder = createAgentResponder({
    db,
    logger: deps.logger,
    now: deps.now,
    provider: builtinProvider,
    events: { emit: () => Promise.resolve() },
    llm,
    llmBudgetUsdMonth: 20,
  });
  await processInboundBatch({ ...deps, responder }, job, { finalAttempt: true });
  return { conversationId: job.conversationId, llm };
}

/** The JSON a tool returned to the model, from the request after the tool call. */
export function toolResult(llm: ScriptedLlm, request: number): Record<string, unknown> | null {
  const last = llm.requests[request]?.messages.at(-1);
  const block = Array.isArray(last?.content) ? last.content[0] : undefined;
  return block?.type === "tool_result" && typeof block.content === "string"
    ? (JSON.parse(block.content) as Record<string, unknown>)
    : null;
}

export const closeCustomer = close;
