import { WA_LIMITS } from "./capabilities.ts";
import type { DocPath } from "./issues.ts";
import type { WaTemplate } from "./meta-schema.ts";

/**
 * Meta's template rules, checked at upload so a rejection shows up now instead of days
 * later. Sources (verified 2026-10): Meta's template components reference (limits) and
 * template review page (common rejection reasons): placeholders must be `{{n}}` with
 * matching braces and no special characters, numbered sequentially, with a sample for
 * each; the body can't start or end with a placeholder; too many placeholders for the
 * message length gets rejected. Meta publishes no exact ratio, so that one is a warning.
 */

export interface RuleIssue {
  path: DocPath;
  message: string;
  severity: "error" | "warning";
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Meta name for a template version: `<key>_v<major>` (spec §9). */
export function metaTemplateName(key: string, major: number): string {
  return `${key}_v${major}`;
}

export function checkWaTemplate(template: WaTemplate): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const error = (path: DocPath, message: string) =>
    issues.push({ path, message, severity: "error" });
  const { body } = template;

  const unbalanced = body.replace(PLACEHOLDER, "").search(/\{\{|\}\}/);
  if (unbalanced !== -1)
    error(["body"], "has mismatched curly braces; placeholders look like {{1}}");

  const numbers: number[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const inner = match[1] ?? "";
    if (!/^\d+$/.test(inner)) {
      error(
        ["body"],
        `placeholder {{${inner}}} must be a number like {{1}} (no spaces or symbols)`,
      );
    } else {
      numbers.push(Number(inner));
    }
  }

  const seen = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) error(["body"], `placeholder {{${n}}} appears more than once`);
    seen.add(n);
  }
  const expectedOrder = [...seen].map((_, i) => i + 1);
  if ([...seen].some((n, i) => n !== expectedOrder[i])) {
    error(
      ["body"],
      `placeholders must be numbered 1, 2, 3… in order of appearance (found ${[...seen].join(", ")})`,
    );
  }

  const trimmed = body.trim();
  if (/^\{\{[^{}]*\}\}/.test(trimmed))
    error(["body"], "must not start with a placeholder (Meta rejects it)");
  if (/\{\{[^{}]*\}\}$/.test(trimmed))
    error(["body"], "must not end with a placeholder (Meta rejects it)");
  if (/\}\}\s*\{\{/.test(body)) error(["body"], "has two placeholders with nothing between them");

  const count = seen.size;
  if (template.variables.length !== count) {
    error(
      ["variables"],
      `has ${template.variables.length} entries but the body has ${count} placeholders`,
    );
  }
  if (template.examples.length !== count) {
    error(
      ["examples"],
      `has ${template.examples.length} entries but the body has ${count} placeholders (Meta requires one sample each)`,
    );
  }
  for (const [i, example] of template.examples.entries()) {
    const problem = parameterValueProblem(example);
    if (problem) error(["examples", i], problem);
  }

  const staticWords = body
    .replace(PLACEHOLDER, " ")
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w)).length;
  if (count > 0 && staticWords < count * 2) {
    issues.push({
      path: ["body"],
      severity: "warning",
      message: `has ${count} placeholders but only ${staticWords} words of fixed text; Meta may reject it as too many variables for its length`,
    });
  }

  const payloads = new Set<string>();
  const texts = new Set<string>();
  for (const [i, button] of template.buttons.entries()) {
    if (payloads.has(button.payload))
      error(["buttons", i, "payload"], `"${button.payload}" is used twice`);
    if (texts.has(button.text)) error(["buttons", i, "text"], `"${button.text}" is used twice`);
    payloads.add(button.payload);
    texts.add(button.text);
  }

  if (metaTemplateName(template.key, 999).length > WA_LIMITS.nameMaxChars) {
    error(["key"], `is too long for a Meta template name (max ${WA_LIMITS.nameMaxChars})`);
  }
  return issues;
}

/**
 * Meta refuses parameter values with newlines, tabs or more than 4 consecutive spaces.
 * Used for samples here and for real values at send time.
 */
export function parameterValueProblem(value: string): string | null {
  if (value.trim() === "") return "must not be empty";
  if (/[\n\t]/.test(value)) return "must not contain newlines or tabs";
  if (/ {5,}/.test(value)) return "must not contain more than 4 consecutive spaces";
  return null;
}
