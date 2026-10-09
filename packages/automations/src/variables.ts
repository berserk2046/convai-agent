import { getPath, type Context, type WaTemplate } from "@platform/templates";

/**
 * Message template parameters (spec §9, decision A10). A variable is a context path, or a
 * list of paths whose first non-empty value wins, with an optional literal fallback. Meta
 * rejects empty parameters, so a variable that is still empty means the run is skipped.
 */

export type ResolvedVariables = { ok: true; values: string[] } | { ok: false; missing: string };

export function resolveVariables(template: WaTemplate, context: Context): ResolvedVariables {
  const values: string[] = [];
  for (const variable of template.variables) {
    const paths = typeof variable === "string" ? [variable] : variable.paths;
    const fallback = typeof variable === "string" ? undefined : variable.fallback;
    const value = paths.map((p) => parameterText(getPath(context, p))).find((v) => v !== "");
    const chosen = value ?? fallback?.trim() ?? "";
    if (chosen === "") return { ok: false, missing: paths.join(" | ") };
    values.push(chosen);
  }
  return { ok: true, values };
}

/**
 * A value as a Meta parameter: text, with what Meta refuses (newlines, tabs, more than 4
 * spaces in a row) flattened to single spaces.
 */
export function parameterText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** The body as the customer reads it: {{n}} replaced by the n-th value. */
export function fillBody(body: string, values: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (all, n: string) => values[Number(n) - 1] ?? all);
}
