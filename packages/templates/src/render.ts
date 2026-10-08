import { agentSettings, type BookingRules, type Context } from "./context.ts";
import type { TemplateRenderer } from "./liquid.ts";
import type { Template } from "./meta-schema.ts";

/**
 * Tidies rendered text: trailing spaces go, and runs of blank lines (left behind by false
 * `{% if %}` blocks) collapse into one. Deterministic, so the cached prompt stays
 * byte-identical between calls.
 */
export function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * System block 1 (spec §7): the rendered system prompt followed by the business facts.
 * Identical for every call of a business on a template version, which is what makes
 * prompt caching possible.
 */
export function renderSystemBlock(
  renderer: TemplateRenderer,
  template: Template,
  business: Context,
  rules: BookingRules | null,
): string {
  const context: Context = { business, agent: agentSettings(template) };
  if (rules) context.booking = rules;
  const prompt = tidy(renderer.render(template.agent.system_prompt, context));
  const facts = tidy(renderer.render(template.agent.facts_template, context));
  return `${prompt}\n\n${facts}`;
}

/** System block 2: the per-call dynamic context (time, calendar, contact, bookings). */
export function renderDynamicBlock(
  renderer: TemplateRenderer,
  template: Template,
  context: Context,
): string {
  return tidy(renderer.render(template.agent.dynamic_context, context));
}
