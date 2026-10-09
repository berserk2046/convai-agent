import {
  TRIGGERS,
  parseDurationMinutes,
  type Automation,
  type SubjectType,
  type Template,
  type TriggerType,
} from "@platform/templates";

/**
 * A template rule as one business runs it: the trigger with the business's overrides of
 * the rule's `overridable` params (e.g. the reminder 48 h ahead instead of 24 h).
 */

export interface EffectiveTrigger {
  type: TriggerType;
  subject: SubjectType;
  params: Record<string, unknown>;
}

export function findRule(template: Template, ruleKey: string): Automation | null {
  return template.automations.find((a) => a.key === ruleKey) ?? null;
}

export function effectiveTrigger(
  rule: Automation,
  overrides: Readonly<Record<string, string>>,
): EffectiveTrigger | null {
  const { type, ...params } = rule.trigger;
  if (!(type in TRIGGERS)) return null;
  const merged: Record<string, unknown> = { ...params };
  for (const entry of rule.overridable ?? []) {
    const value = overrides[entry];
    const param = entry.slice("trigger.".length);
    if (value !== undefined && entry.startsWith("trigger.")) merged[param] = value;
  }
  const declaration = TRIGGERS[type as TriggerType];
  // Overrides are validated on write; a bad one falls back to the template's value.
  const parsed = declaration.params.safeParse(merged);
  return {
    type: type as TriggerType,
    subject: declaration.subject,
    params: parsed.success ? parsed.data : params,
  };
}

/** Problems with a business's overrides for a rule, as `path: message` lines. */
export function overrideProblems(
  rule: Automation,
  overrides: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const allowed = new Set(rule.overridable ?? []);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) problems.push(`${key}: can't be changed for ${rule.key}`);
  }
  if (problems.length > 0) return problems;
  const { type, ...params } = rule.trigger;
  if (!(type in TRIGGERS)) return [`trigger: unknown type ${type}`];
  const merged: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(overrides))
    merged[key.slice("trigger.".length)] = value;
  const parsed = TRIGGERS[type as TriggerType].params.safeParse(merged);
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map((i) => `trigger.${i.path.map(String).join(".")}: ${i.message}`),
    );
  }
  return problems;
}

/** A trigger's offset or duration param in minutes ("-24h" → -1440); 0 when absent. */
export function minutesParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  return typeof value === "string" ? (parseDurationMinutes(value) ?? 0) : 0;
}
