import {
  claimEmergencyReply,
  grantConsent,
  markConsentRequested,
  openHandoff,
  optOutContact,
  recordUsage,
  setHandoffReason,
  usageCostSince,
  withTenant,
} from "@platform/db";
import {
  costUsd,
  isKnownModel,
  isRetryableLlmError,
  meteredLlm,
  toolInputSchema,
  type Anthropic,
  type LlmClient,
  type TokenUsage,
} from "@platform/llm";
import { alert } from "@platform/shared";
import type { ToolName } from "@platform/templates";
import type { InboundBatch, Reply, Responder, ResponderInfo } from "../inbound/process.ts";
import {
  allowedPrices,
  capReplyLength,
  matchesAny,
  matchesEmergency,
  matchesOptOut,
  monthStart,
  priceViolations,
} from "./guardrails.ts";
import { buildHistory } from "./history.ts";
import { rewrite, runModel, type ModelRequest, type ModelRun, type ToolCallLog } from "./loop.ts";
import { catalogAt } from "./tools/catalog.ts";
import { AGENT_TOOLS, requiresConsent } from "./tools/registry.ts";
import { toolError, type ToolOutcome } from "./tools/types.ts";
import { dynamicBlock, loadTurn, renderReply, type Turn, type TurnDeps } from "./turn.ts";

/**
 * The agent (spec §7): deterministic guardrails first, then consent, then the model with
 * the template's tools, then the price guard and the length cap. Every reply the customer
 * reads is template text or written by the model under the template's prompt.
 */

export interface AgentDeps extends TurnDeps {
  llm: LlmClient;
  /** Monthly LLM cap when the business has none of its own (principle 10). */
  llmBudgetUsdMonth: number;
}

/** Message types the agent can't read (spec §7.2: reply with unsupported_media). */
const MEDIA_TYPES = new Set([
  "audio",
  "image",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
]);

const PRE_CONSENT_NOTE =
  "The customer has not accepted the data-processing consent message yet (it was sent to them). Booking, " +
  "rescheduling and cancelling are disabled until they do. Answer general questions; if they want an appointment, " +
  "ask them to accept the consent message first.";
const CONSENT_GIVEN_NOTE =
  "The customer just accepted the data-processing consent. Continue with what they asked for earlier.";

export function createAgentResponder(deps: AgentDeps): Responder {
  return async (batch, info) => {
    const turn = await loadTurn(deps, batch);
    return turn ? respond(deps, turn, batch, info) : [];
  };
}

async function respond(
  deps: AgentDeps,
  turn: Turn,
  batch: InboundBatch,
  info: ResponderInfo,
): Promise<Reply[]> {
  const { template, tool } = turn;
  const guardrails = template.guardrails;
  const fixed = (source: string): Reply => ({
    body: renderReply(source, turn.context),
    meta: { kind: "fixed" },
  });
  const text = batch.messages
    .filter((m) => m.body !== null && m.body.trim() !== "")
    .map((m) => (m.body ?? "").trim())
    .join("\n");
  const hasMedia = batch.messages.some((m) => MEDIA_TYPES.has(m.type));

  // Pre-guardrails, in spec order, before consent (spec §7.2).
  if (text && matchesEmergency(text, guardrails.emergency.patterns)) {
    return (await emergency(deps, turn)) ? [fixed(guardrails.emergency.reply)] : [];
  }
  if (text && matchesOptOut(text, guardrails.opt_out_keywords)) {
    await withTenant(tool.db, tool.business.id, (tx) =>
      optOutContact(tx, tool.contact.id, tool.now),
    );
    log(deps, turn).info("contact opted out of automatic messages");
    return [fixed(guardrails.opt_out_reply)];
  }
  if (tool.conversation.mode === "human") {
    // Principle 7: a person is handling it; the message waits for them in the inbox.
    log(deps, turn).info("message for staff (handoff open)");
    return [];
  }
  const replies: Reply[] = [];
  if (hasMedia) {
    replies.push(fixed(template.agent.unsupported_media));
    if (!text) return replies;
  }
  if (await overBudget(deps, turn)) {
    await handOff(deps, turn, "budget", "Monthly AI budget reached");
    alert(
      log(deps, turn),
      "llm_budget_reached",
      {},
      "monthly LLM budget reached; conversations go to staff",
    );
    return [...replies, fixed(template.agent.handoff_reply)];
  }

  const consent = await consentStep(turn, text, fixed);
  replies.push(...consent.replies);
  if (!consent.runAgent) return replies;

  replies.push(...(await agentReplies(deps, turn, batch, info, consent.notes, fixed)));
  return replies;
}

/** Opens (or escalates) the emergency handoff; true if the emergency reply should go out (A3). */
async function emergency(deps: AgentDeps, turn: Turn): Promise<boolean> {
  const { tool } = turn;
  const reason = turn.template.guardrails.emergency.handoff_reason;
  const reply = await withTenant(tool.db, tool.business.id, async (tx) => {
    const { handoff, created } = await openHandoff(tx, {
      businessId: tool.business.id,
      conversationId: tool.conversation.id,
      reason,
      summary: "Emergency keywords in the customer's message",
    });
    if (!created && handoff.reason !== reason) await setHandoffReason(tx, handoff.id, reason);
    return claimEmergencyReply(tx, handoff.id);
  });
  alert(
    log(deps, turn),
    "handoff_emergency",
    { reason },
    "emergency: conversation handed to staff",
  );
  return reply;
}

async function overBudget(deps: AgentDeps, turn: Turn): Promise<boolean> {
  const { tool } = turn;
  const budget = tool.business.limits.llm_usd_month ?? deps.llmBudgetUsdMonth;
  const spent = await withTenant(tool.db, tool.business.id, (tx) =>
    usageCostSince(tx, tool.business.id, "llm", monthStart(tool.now, tool.timezone)),
  );
  return spent >= budget;
}

/** Decision A9: consent message once (daily at most when FAQ isn't allowed), acceptance unlocks booking. */
async function consentStep(
  turn: Turn,
  text: string,
  fixed: (source: string) => Reply,
): Promise<{ replies: Reply[]; runAgent: boolean; notes: string[] }> {
  const { tool } = turn;
  const consent = turn.template.consent;
  const contact = tool.contact;
  if (contact.consentAt) return { replies: [], runAgent: true, notes: [] };

  if (contact.consentRequestedAt && matchesAny(text, consent.accept_patterns)) {
    await withTenant(tool.db, tool.business.id, (tx) =>
      grantConsent(tx, contact.id, "whatsapp", tool.now),
    );
    tool.consentGiven = true;
    return { replies: [], runAgent: true, notes: [CONSENT_GIVEN_NOTE] };
  }

  const requestedAt = contact.consentRequestedAt?.getTime();
  const resend =
    requestedAt === undefined ||
    (!consent.allow_faq_before_consent && tool.now.getTime() - requestedAt >= 86_400_000);
  const replies: Reply[] = [];
  if (resend) {
    await withTenant(tool.db, tool.business.id, (tx) =>
      markConsentRequested(tx, contact.id, tool.now),
    );
    replies.push(fixed(consent.message));
  }
  if (!consent.allow_faq_before_consent) return { replies, runAgent: false, notes: [] };
  return { replies, runAgent: true, notes: [PRE_CONSENT_NOTE] };
}

async function agentReplies(
  deps: AgentDeps,
  turn: Turn,
  batch: InboundBatch,
  info: ResponderInfo,
  consentNotes: string[],
  fixed: (source: string) => Reply,
): Promise<Reply[]> {
  const { tool, template } = turn;
  const agent = template.agent;
  // Template order (capabilities is an array; jsonb storage reorders object keys), so the
  // tool list, and with it the cached prefix, is stable and template-defined.
  const enabled = new Map(
    template.manifest.capabilities.tools
      .filter((name): name is ToolName => name in agent.tools && name in AGENT_TOOLS)
      .filter((name) => tool.consentGiven || !requiresConsent(name))
      .map((name) => [name, agent.tools[name] ?? {}] as const),
  );
  const tools: Anthropic.Tool[] = [...enabled.keys()].map((name) => ({
    name,
    description: AGENT_TOOLS[name].description,
    input_schema: toolInputSchema(AGENT_TOOLS[name].input(tool)),
  }));
  const history = buildHistory(turn.recent, batch.messages);
  const notes = [
    ...consentNotes,
    ...(history.openingNote
      ? [`The conversation started with this message from the business: "${history.openingNote}"`]
      : []),
  ];
  const model = tool.business.agentOverrides.model ?? agent.model;
  if (!isKnownModel(model)) {
    // Spend we can't price can't be capped (principle 10): refuse rather than guess.
    alert(log(deps, turn), "llm_model_unpriced", { model }, "model has no price; handing off");
    await handOff(deps, turn, "error", "The configured AI model has no known price");
    return [fixed(agent.handoff_reply)];
  }
  const request: ModelRequest = {
    model,
    // Block 1 is identical for every call of this business and template version, so it can be cached.
    system: [
      { type: "text", text: turn.systemBlock, cache_control: { type: "ephemeral" } },
      { type: "text", text: await dynamicBlock(turn, notes) },
    ],
    messages: history.messages,
    tools,
  };

  const llm = meteredLlm(deps.llm);
  let result: ModelTurn;
  try {
    result = await modelTurn(deps, turn, llm, request, enabled, info, fixed);
  } finally {
    // Tokens are paid for even when the turn fails midway (principle 10).
    await recordSpend(deps, turn, model, llm.usage);
  }
  const [first, ...rest] = result.replies;
  if (!first) return [];
  const meta = {
    kind: first.meta?.kind ?? "agent",
    model,
    usage: llm.usage,
    costUsd: costUsd(model, llm.usage),
    toolCalls: result.toolCalls,
  };
  return [{ ...first, meta }, ...rest];
}

interface ModelTurn {
  replies: Reply[];
  toolCalls: ToolCallLog[];
}

/** Spec §7 steps 5 and 6: the tool loop, then the price guard and the length cap. */
async function modelTurn(
  deps: AgentDeps,
  turn: Turn,
  llm: LlmClient,
  request: ModelRequest,
  enabled: ReadonlyMap<ToolName, Record<string, unknown>>,
  info: ResponderInfo,
  fixed: (source: string) => Reply,
): Promise<ModelTurn> {
  const agent = turn.template.agent;
  let run: ModelRun;
  try {
    run = await runModel(
      llm,
      request,
      (name, input) => executeTool(turn, enabled, name, input),
      agent.max_tool_calls_per_turn,
    );
  } catch (error) {
    if (isRetryableLlmError(error) && !info.finalAttempt) throw error;
    alert(log(deps, turn), "llm_failed", { err: error }, "the model could not answer; handing off");
    await handOff(deps, turn, "error", "The assistant could not answer (AI service error)");
    return { replies: [fixed(agent.handoff_reply)], toolCalls: [] };
  }
  const { toolCalls } = run;

  if (run.exceededToolCalls || run.refused) {
    await handOff(
      deps,
      turn,
      "error",
      run.refused ? "The model declined to answer" : "Too many tool calls in one turn",
    );
    return { replies: [fixed(agent.handoff_reply)], toolCalls };
  }

  const text = await priceChecked(deps, turn, llm, request, run);
  if (text === null) {
    await handOff(
      deps,
      turn,
      "price_guard",
      "The assistant tried to quote a price that isn't in the catalog",
    );
    return { replies: [fixed(agent.fallback_reply)], toolCalls };
  }

  const replies: Reply[] = [];
  if (text) {
    const capped = capReplyLength(text, agent.max_reply_words);
    if (capped.trimmed)
      log(deps, turn).warn(
        { max_words: agent.max_reply_words },
        "reply cut at the hard length cap",
      );
    replies.push({ body: capped.text, meta: { kind: "agent" } });
  }
  if (run.handoff) {
    replies.push(fixed(agent.handoff_reply));
  } else if (!text) {
    await handOff(deps, turn, "error", "The model returned no reply");
    replies.push(fixed(agent.handoff_reply));
  }
  return { replies, toolCalls };
}

/**
 * Price guard (spec §7.6): the reply if every amount in it is a catalog price, else one
 * rewrite with tools off. Null when the rewrite still invents a price, or fails: a turn
 * whose tools already ran (maybe a handoff) is not worth retrying from the start.
 */
async function priceChecked(
  deps: AgentDeps,
  turn: Turn,
  llm: LlmClient,
  request: ModelRequest,
  run: ModelRun,
): Promise<string | null> {
  const guard = turn.template.guardrails.price_guard;
  if (!run.text || !guard.enabled) return run.text;
  const allowed = allowedPrices(
    catalogAt(turn.tool.config, guard.catalog_path),
    guard.price_field,
    guard.price_type_field,
  );
  const violations = priceViolations(run.text, allowed);
  if (violations.length === 0) return run.text;

  log(deps, turn).warn(
    { amounts: violations },
    "price guard: reply mentioned non-catalog amounts; retrying",
  );
  const second = await rewrite(llm, request, run.transcript, priceNote(violations)).catch(
    (error: unknown) => {
      log(deps, turn).warn({ err: error }, "price guard: the rewrite failed");
      return "";
    },
  );
  if (second && priceViolations(second, allowed).length === 0) return second;
  alert(
    log(deps, turn),
    "price_guard",
    { amounts: violations },
    "price guard failed twice; handing off",
  );
  return null;
}

/** Records the turn's LLM spend in usage_events (the monthly budget reads it). */
async function recordSpend(
  deps: AgentDeps,
  turn: Turn,
  model: string,
  usage: TokenUsage,
): Promise<void> {
  const units = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (units === 0) return;
  const { tool } = turn;
  const cost = costUsd(model, usage);
  await withTenant(tool.db, tool.business.id, (tx) =>
    recordUsage(tx, {
      businessId: tool.business.id,
      kind: "llm",
      units,
      costUsd: cost,
      details: { model, ...usage, conversation_id: tool.conversation.id },
    }),
  );
  // cache_read shows whether prompt caching actually works (spec §7.4).
  log(deps, turn).info({ model, usage, cost_usd: cost }, "agent turn");
}

async function executeTool(
  turn: Turn,
  enabled: ReadonlyMap<ToolName, Record<string, unknown>>,
  name: string,
  rawInput: unknown,
): Promise<ToolOutcome> {
  const { tool } = turn;
  const params = enabled.get(name as ToolName);
  if (!params) return toolError("tool_not_available", `The tool "${name}" is not available here.`);
  if (requiresConsent(name as ToolName) && !tool.consentGiven) {
    return toolError("consent_required", "Ask the customer to accept the consent message first.");
  }
  const implementation = AGENT_TOOLS[name as ToolName];
  const parsed = implementation.input(tool).safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
    return toolError("invalid_input", "Fix the input and call again.", { issues });
  }
  try {
    return await implementation.run(tool, parsed.data as Record<string, unknown>, params);
  } catch (error) {
    alert(
      tool.logger,
      "tool_failed",
      { tool: name, business_id: tool.business.id, err: error },
      "tool failed",
    );
    return toolError(
      "tool_failed",
      "Something went wrong on our side. Offer to pass the conversation to a person (handoff).",
    );
  }
}

async function handOff(
  deps: AgentDeps,
  turn: Turn,
  reason: string,
  summary: string,
): Promise<void> {
  const { tool } = turn;
  await withTenant(tool.db, tool.business.id, (tx) =>
    openHandoff(tx, {
      businessId: tool.business.id,
      conversationId: tool.conversation.id,
      reason,
      summary,
    }),
  );
  log(deps, turn).info({ reason }, "handoff opened");
}

function priceNote(amounts: number[]): string {
  return (
    `Your previous draft mentioned amounts that are not catalog prices (${amounts.join(", ")}). Write the reply ` +
    "again. Only mention a price exactly as the catalog has it; for services priced after evaluation never give " +
    "an amount; never add up or estimate prices."
  );
}

function log(deps: AgentDeps, turn: Turn) {
  return deps.logger.child({
    business_id: turn.tool.business.id,
    conversation_id: turn.tool.conversation.id,
  });
}
