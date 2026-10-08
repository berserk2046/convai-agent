import { TOOLS } from "../capabilities.ts";
import { getPath } from "../context.ts";
import type { DocPath } from "../issues.ts";
import { isObject } from "../json-schema/platform-types.ts";
import type { EvalScenario } from "../meta-schema.ts";
import { contactFieldKeys, type CheckContext } from "./check-context.ts";

/** Rule 9: evals reference enabled tools, real services and existing fixtures. */
export function checkEvals(ctx: CheckContext): void {
  const { evals, agent, eval_fixtures: fixtures } = ctx.template;
  const enabled = Object.keys(agent.tools);
  const reasons = Array.isArray(agent.tools.handoff?.reasons)
    ? (agent.tools.handoff.reasons as unknown[])
    : [];
  const services = catalogItems(ctx);
  const ids = evals.map((e) => e.id);

  const kind = ctx.samples?.rules?.resource_kind;
  if (typeof kind === "string" && !fixtures?.resources?.some((r) => r.kind === kind)) {
    ctx.issues.error(
      ["eval_fixtures", "resources"],
      `needs at least one resource of kind "${kind}" so booking evals have somewhere to book`,
    );
  }

  for (const [i, scenario] of evals.entries()) {
    const path: DocPath = ["evals", i];
    if (ids.indexOf(scenario.id) !== i)
      ctx.issues.error([...path, "id"], `"${scenario.id}" is used twice`);
    checkTurns(ctx, scenario, path, enabled);
    checkFixtures(ctx, scenario, path, services);

    const { assert } = scenario;
    const a: DocPath = [...path, "assert"];
    if (assert.tool_called !== undefined)
      checkTool(ctx, [...a, "tool_called"], assert.tool_called, enabled, true);
    assert.no_tool?.forEach((tool, j) => {
      checkTool(ctx, [...a, "no_tool", j], tool, enabled, false);
    });
    if (assert.booking_created) {
      checkService(
        ctx,
        [...a, "booking_created", "service_key"],
        assert.booking_created.service_key,
        services,
      );
    }
    if (assert.handoff && !reasons.includes(assert.handoff.reason)) {
      ctx.issues.error(
        [...a, "handoff", "reason"],
        `"${assert.handoff.reason}" is not one of agent.tools.handoff.reasons`,
      );
    }
    if (assert.reply_contains_price) {
      const key = assert.reply_contains_price.service_key;
      const item = checkService(ctx, [...a, "reply_contains_price", "service_key"], key, services);
      const priceField = ctx.template.guardrails.price_guard.price_field;
      if (item && typeof item[priceField] !== "number") {
        ctx.issues.error(
          [...a, "reply_contains_price", "service_key"],
          `"${key}" has no ${priceField} in sample_config`,
        );
      }
    }
  }
}

function checkTurns(
  ctx: CheckContext,
  scenario: EvalScenario,
  path: DocPath,
  enabled: string[],
): void {
  if (scenario.turns[0]?.user === undefined) {
    ctx.issues.error([...path, "turns", 0], "the first turn must be a user message");
  }
  scenario.turns.forEach((turn, j) => {
    if (turn.expect_tool !== undefined && !enabled.includes(turn.expect_tool)) {
      ctx.issues.error(
        [...path, "turns", j, "expect_tool"],
        `"${turn.expect_tool}" is not enabled in agent.tools`,
      );
    }
  });
}

function checkFixtures(
  ctx: CheckContext,
  scenario: EvalScenario,
  path: DocPath,
  services: Record<string, unknown>[] | null,
): void {
  scenario.fixtures?.bookings?.forEach((booking, j) => {
    const p: DocPath = [...path, "fixtures", "bookings", j, "service_key"];
    const item = checkService(ctx, p, booking.service_key, services);
    if (item && item.bookable === false)
      ctx.issues.error(p, `"${booking.service_key}" is not bookable`);
  });
  const fields = contactFieldKeys(ctx);
  for (const key of Object.keys(scenario.fixtures?.contact?.fields ?? {})) {
    if (!fields.includes(key)) {
      ctx.issues.error(
        [...path, "fixtures", "contact", "fields", key],
        `"${key}" is not in contact_fields`,
      );
    }
  }
}

function checkTool(
  ctx: CheckContext,
  path: DocPath,
  tool: string,
  enabled: string[],
  mustBeEnabled: boolean,
): void {
  if (!(tool in TOOLS)) ctx.issues.error(path, `unknown tool "${tool}"`);
  else if (!enabled.includes(tool)) {
    if (mustBeEnabled)
      ctx.issues.error(path, `"${tool}" is not enabled in agent.tools, so it can never be called`);
    else ctx.issues.warning(path, `"${tool}" is not enabled in agent.tools, so this always passes`);
  }
}

function checkService(
  ctx: CheckContext,
  path: DocPath,
  key: string,
  services: Record<string, unknown>[] | null,
): Record<string, unknown> | null {
  if (!services) return null;
  const item = services.find((s) => s.key === key);
  if (!item) ctx.issues.error(path, `"${key}" is not a service in sample_config`);
  return item ?? null;
}

function catalogItems(ctx: CheckContext): Record<string, unknown>[] | null {
  if (!ctx.sampleConfig) return null;
  const path = ctx.samples?.rules?.catalog_path ?? ctx.template.guardrails.price_guard.catalog_path;
  const catalog = getPath(ctx.sampleConfig, path);
  return Array.isArray(catalog) ? catalog.filter(isObject) : null;
}
