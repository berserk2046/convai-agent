import { extractMoneyAmounts, normalize, type ToolCallLog } from "@platform/core";
import { compileTemplateRegex, type EvalScenario } from "@platform/templates";
import type { SandboxState } from "./sandbox.ts";

/**
 * Deterministic eval assertions (spec §11). Pure: they read what the scenario observed.
 * The `judge` assertion needs a model call and lives in judge.ts.
 *
 * Semantics (docs/templates.md):
 * - `reply_contains` and `reply_contains_price` read the replies to the last user message;
 *   `reply_not_matches` reads every reply in the scenario (spec review B32).
 * - `reply_contains` ignores case and accents; regexes use the template flags (`iu`).
 * - `tool_called` needs a call that succeeded; `no_tool` fails on any attempt.
 * - `bookings_count` counts the customer's active (pending or confirmed) bookings at the
 *   end, fixtures included; `booking_created` looks only at bookings made in the scenario.
 */

export interface ObservedTurn {
  user: string;
  replies: { body: string; kind: string }[];
  toolCalls: ToolCallLog[];
}

export interface Observation {
  turns: ObservedTurn[];
  state: SandboxState;
  /** The catalog items of the business config (`guardrails.price_guard.catalog_path`). */
  catalog: Record<string, unknown>[];
  priceField: string;
}

export interface AssertionResult {
  /** The assertion key, e.g. "booking_created". */
  name: string;
  passed: boolean;
  /** Why, in a sentence the owner can act on. */
  detail: string;
}

type Assert = EvalScenario["assert"];

const ACTIVE = new Set(["pending", "confirmed"]);

export function checkAssertions(assert: Assert, observed: Observation): AssertionResult[] {
  const results: AssertionResult[] = [];
  const allCalls = observed.turns.flatMap((t) => t.toolCalls);
  const lastReplies = observed.turns.at(-1)?.replies.map((r) => r.body) ?? [];
  const allReplies = observed.turns.flatMap((t) => t.replies.map((r) => r.body));

  if (assert.tool_called !== undefined) results.push(toolCalled(assert.tool_called, allCalls));
  if (assert.no_tool) results.push(noTool(assert.no_tool, allCalls));
  if (assert.booking_created) results.push(bookingCreated(assert.booking_created, observed));
  if (assert.bookings_count !== undefined)
    results.push(bookingsCount(assert.bookings_count, observed));
  if (assert.handoff) results.push(handoff(assert.handoff.reason, observed));
  if (assert.no_handoff) results.push(noHandoff(observed));
  if (assert.reply_contains) results.push(replyContains(assert.reply_contains, lastReplies));
  if (assert.reply_not_matches) results.push(replyNotMatches(assert.reply_not_matches, allReplies));
  if (assert.reply_contains_price)
    results.push(
      replyContainsPrice(assert.reply_contains_price.service_key, lastReplies, observed),
    );
  return results;
}

/** An `expect_tool` checkpoint: the tool succeeded during the latest user turn. */
export function expectTool(tool: string, turn: ObservedTurn | undefined): AssertionResult {
  const ok = (turn?.toolCalls ?? []).some((c) => c.name === tool && !c.isError);
  return {
    name: "expect_tool",
    passed: ok,
    detail: ok
      ? `${tool} was called after "${clip(turn?.user ?? "")}"`
      : `${tool} was not called after "${clip(turn?.user ?? "")}" (calls: ${callNames(turn?.toolCalls ?? [])})`,
  };
}

function toolCalled(tool: string, calls: readonly ToolCallLog[]): AssertionResult {
  const ok = calls.some((c) => c.name === tool && !c.isError);
  return {
    name: "tool_called",
    passed: ok,
    detail: ok
      ? `${tool} was called`
      : `${tool} was never called successfully (calls: ${callNames(calls)})`,
  };
}

function noTool(tools: readonly string[], calls: readonly ToolCallLog[]): AssertionResult {
  const used = tools.filter((tool) => calls.some((c) => c.name === tool));
  return {
    name: "no_tool",
    passed: used.length === 0,
    detail:
      used.length === 0 ? `none of ${tools.join(", ")} was called` : `called ${used.join(", ")}`,
  };
}

function bookingCreated(
  expected: NonNullable<Assert["booking_created"]>,
  observed: Observation,
): AssertionResult {
  const created = observed.state.bookings.filter((b) => !b.fixture && ACTIVE.has(b.status));
  const ok = created.some(
    (b) =>
      b.serviceKey === expected.service_key &&
      b.localDate === expected.local_date &&
      b.localTime === expected.local_time,
  );
  const want = `${expected.service_key} on ${expected.local_date} at ${expected.local_time}`;
  return {
    name: "booking_created",
    passed: ok,
    detail: ok
      ? `booked ${want}`
      : `no booking for ${want} (created: ${created.map((b) => `${b.serviceKey} ${b.localDate} ${b.localTime}`).join("; ") || "none"})`,
  };
}

function bookingsCount(expected: number, observed: Observation): AssertionResult {
  const active = observed.state.bookings.filter((b) => ACTIVE.has(b.status)).length;
  return {
    name: "bookings_count",
    passed: active === expected,
    detail: `${String(active)} active booking(s), expected ${String(expected)}`,
  };
}

function handoff(reason: string, observed: Observation): AssertionResult {
  const reasons = observed.state.handoffs.map((h) => h.reason);
  const ok = reasons.includes(reason);
  return {
    name: "handoff",
    passed: ok,
    detail: ok
      ? `handed off (${reason})`
      : `no handoff with reason ${reason} (handoffs: ${reasons.join(", ") || "none"})`,
  };
}

function noHandoff(observed: Observation): AssertionResult {
  const reasons = observed.state.handoffs.map((h) => h.reason);
  return {
    name: "no_handoff",
    passed: reasons.length === 0,
    detail: reasons.length === 0 ? "no handoff" : `handed off (${reasons.join(", ")})`,
  };
}

function replyContains(needles: readonly string[], replies: readonly string[]): AssertionResult {
  const text = normalize(replies.join("\n"));
  const missing = needles.filter((n) => !text.includes(normalize(n)));
  return {
    name: "reply_contains",
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `the last reply mentions ${needles.map(quote).join(", ")}`
        : `the last reply doesn't mention ${missing.map(quote).join(", ")}`,
  };
}

function replyNotMatches(patterns: readonly string[], replies: readonly string[]): AssertionResult {
  const hits = patterns.flatMap((source) => {
    const regex = compileTemplateRegex(source);
    const hit = replies.find((r) => regex.test(r));
    return hit === undefined ? [] : [`/${source}/ in "${clip(hit)}"`];
  });
  return {
    name: "reply_not_matches",
    passed: hits.length === 0,
    detail: hits.length === 0 ? "no reply matches the forbidden patterns" : hits.join("; "),
  };
}

function replyContainsPrice(
  serviceKey: string,
  replies: readonly string[],
  observed: Observation,
): AssertionResult {
  const item = observed.catalog.find((i) => i.key === serviceKey);
  const price = item?.[observed.priceField];
  if (typeof price !== "number") {
    return {
      name: "reply_contains_price",
      passed: false,
      detail: `${serviceKey} has no ${observed.priceField} in the config`,
    };
  }
  const amounts = extractMoneyAmounts(replies.join("\n"));
  const ok = amounts.includes(price);
  return {
    name: "reply_contains_price",
    passed: ok,
    detail: ok
      ? `the last reply quotes ${String(price)} for ${serviceKey}`
      : `the last reply doesn't quote ${String(price)} for ${serviceKey} (amounts: ${amounts.join(", ") || "none"})`,
  };
}

function callNames(calls: readonly ToolCallLog[]): string {
  if (calls.length === 0) return "none";
  return calls.map((c) => (c.isError ? `${c.name} (error)` : c.name)).join(", ");
}

function quote(text: string): string {
  return `"${text}"`;
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
