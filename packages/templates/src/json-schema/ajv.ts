import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { DocPath } from "../issues.ts";
import { PLATFORM_TYPE_KEYWORD } from "./platform-types.ts";

export type { ValidateFunction };

/** Widgets the admin form generator knows how to render. */
export const UI_WIDGETS = ["textarea", "weekly-hours", "table"] as const;

const X_UI_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    section: { type: "string" },
    order: { type: "number" },
    help: { type: "string" },
    widget: { enum: UI_WIDGETS },
    /** Display names for an `enum`'s values, `{ value: "Label" }`; the value is what's stored. */
    labels: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
  },
};

/**
 * A fresh strict Ajv (draft 2020-12) with formats, defaults and our annotation keywords.
 * One instance per compiled schema keeps unrelated templates from sharing compile caches.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: true });
  formats.default(ajv);
  ajv.addKeyword({ keyword: "x-ui", metaSchema: X_UI_META_SCHEMA });
  ajv.addKeyword({ keyword: PLATFORM_TYPE_KEYWORD, metaSchema: { type: "string" } });
  return ajv;
}

export interface SchemaIssue {
  path: DocPath;
  message: string;
}

/** "/services/0/price_cop" → ["services", 0, "price_cop"] */
export function pointerToPath(pointer: string): DocPath {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** Turns Ajv errors into path + message pairs that point at the offending field. */
export function ajvErrorsToIssues(
  errors: readonly ErrorObject[] | null | undefined,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  for (const error of errors ?? []) {
    // `if` failures are always accompanied by the `then`/`else` error that explains them.
    if (error.keyword === "if") continue;
    const path = pointerToPath(error.instancePath);
    const params = error.params as Record<string, unknown>;
    if (error.keyword === "required") {
      issues.push({ path: [...path, String(params.missingProperty)], message: "is required" });
    } else if (error.keyword === "additionalProperties") {
      issues.push({
        path: [...path, String(params.additionalProperty)],
        message: "is not allowed",
      });
    } else if (error.keyword === "enum") {
      const allowed = (params.allowedValues as unknown[]).map((v) => JSON.stringify(v));
      issues.push({ path, message: `must be one of ${allowed.join(", ")}` });
    } else {
      issues.push({ path, message: error.message ?? `fails "${error.keyword}"` });
    }
  }
  return dedupe(issues);
}

function dedupe(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path.join("/")}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
