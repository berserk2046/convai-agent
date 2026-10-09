import {
  InvalidInputError,
  getBusiness,
  getTemplateVersion,
  preparedTemplateFor,
  setAutomationSettings,
  type AutomationRow,
  type Executor,
} from "@platform/db";
import { findRule, overrideProblems } from "./rules.ts";

/**
 * A business admin turns a rule on or off, or changes what the rule allows (spec §12
 * /automations: `overridable` timing). Overrides are checked against the pinned template.
 * Run it inside the business's withTenant() transaction.
 */
export async function updateAutomationSettings(
  db: Executor,
  businessId: string,
  ruleKey: string,
  settings: { enabled?: boolean; overrides?: Record<string, string> },
): Promise<AutomationRow> {
  const business = await getBusiness(db, businessId);
  const row = business
    ? await getTemplateVersion(db, business.templateSlug, business.templateVersion)
    : null;
  const rule = row ? findRule(preparedTemplateFor(row).template, ruleKey) : null;
  if (!rule) {
    throw new InvalidInputError("automation", [
      { path: "ruleKey", message: `unknown rule "${ruleKey}"` },
    ]);
  }
  if (settings.overrides) {
    const problems = overrideProblems(rule, settings.overrides);
    if (problems.length > 0) {
      throw new InvalidInputError(
        "automation",
        problems.map((p) => {
          const [path = "", ...message] = p.split(": ");
          return { path: `overrides.${path}`, message: message.join(": ") };
        }),
      );
    }
  }
  const updated = await setAutomationSettings(db, businessId, ruleKey, settings);
  if (!updated) {
    throw new InvalidInputError("automation", [
      { path: "ruleKey", message: `"${ruleKey}" is not set up for this business` },
    ]);
  }
  return updated;
}
