import { WEEKDAY_KEYS } from "@platform/shared";
import type { DocPath } from "../issues.ts";
import {
  ajvErrorsToIssues,
  createAjv,
  pointerToPath,
  type SchemaIssue,
  type ValidateFunction,
} from "./ajv.ts";
import {
  PLATFORM_TYPE_KEYWORD,
  isObject,
  resolvePlatformRefs,
  type JsonSchema,
} from "./platform-types.ts";

export interface CompiledSchema {
  /** The schema with platform refs inlined; what the admin form generator renders. */
  schema: JsonSchema;
  validate: ValidateFunction;
}

/**
 * Resolves platform refs, checks the result is a valid JSON Schema 2020-12 object schema,
 * and compiles it in strict mode. Issue paths are relative to the schema root.
 */
export function compileObjectSchema(
  raw: unknown,
): { compiled: CompiledSchema; issues: [] } | { compiled: null; issues: SchemaIssue[] } {
  const { schema, issues } = resolvePlatformRefs(raw);
  if (issues.length > 0) return { compiled: null, issues };
  if (!isObject(schema) || schema.type !== "object") {
    return {
      compiled: null,
      issues: [{ path: ["type"], message: 'must be "object" at the root' }],
    };
  }

  const ajv = createAjv();
  if (!ajv.validateSchema(schema)) {
    return {
      compiled: null,
      issues: (ajv.errors ?? []).map((e) => ({
        path: pointerToPath(e.instancePath),
        message: e.message ?? `fails "${e.keyword}"`,
      })),
    };
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    // Strict-mode and keyword failures come as plain errors; recover a path from the text.
    const message = error instanceof Error ? error.message : String(error);
    return { compiled: null, issues: [locateCompileError(schema, message)] };
  }
  const labelIssues = checkUiLabels(schema, []);
  if (labelIssues.length > 0) return { compiled: null, issues: labelIssues };
  return { compiled: { schema, validate }, issues: [] };
}

/** Keys holding data rather than subschemas: nothing to check inside them. */
const DATA_KEYWORDS = new Set(["x-ui", "enum", "const", "default", "examples"]);

/** `x-ui.labels` name the values of an `enum` on the same field, and only those values. */
function checkUiLabels(node: unknown, path: DocPath): SchemaIssue[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => checkUiLabels(item, [...path, i]));
  if (!isObject(node)) return [];
  const issues: SchemaIssue[] = [];
  const labels = isObject(node["x-ui"]) ? node["x-ui"].labels : undefined;
  if (isObject(labels)) {
    const at: DocPath = [...path, "x-ui", "labels"];
    if (!Array.isArray(node.enum)) {
      issues.push({ path: at, message: 'is only for fields with "enum": it names their values' });
    } else {
      const values = node.enum.map(String);
      for (const key of Object.keys(labels).filter((k) => !values.includes(k))) {
        issues.push({
          path: [...at, key],
          message: `"${key}" is not one of the field's values (${values.join(", ")})`,
        });
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (!DATA_KEYWORDS.has(key)) issues.push(...checkUiLabels(value, [...path, key]));
  }
  return issues;
}

function locateCompileError(schema: unknown, message: string): SchemaIssue {
  // keyword "x-ui" value is invalid at path "#/properties/a": data/widget must be …
  const invalid = /keyword "([^"]+)" value is invalid at path "#([^"]*)": data(\S*) (.*)$/.exec(
    message,
  );
  if (invalid) {
    const [, keyword = "", at = "", inner = "", reason = message] = invalid;
    return { path: [...pointerToPath(at), keyword, ...pointerToPath(inner)], message: reason };
  }
  // strict mode: unknown keyword: "maxLenght"
  const keyword = /keyword: "([^"]+)"/.exec(message)?.[1];
  return { path: keyword === undefined ? [] : (findKey(schema, keyword, []) ?? []), message };
}

function findKey(node: unknown, key: string, path: DocPath): DocPath | null {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      const found = findKey(item, key, [...path, i]);
      if (found) return found;
    }
  } else if (isObject(node)) {
    if (key in node) return [...path, key];
    for (const [k, v] of Object.entries(node)) {
      const found = findKey(v, key, [...path, k]);
      if (found) return found;
    }
  }
  return null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

/**
 * Validates data against a compiled schema. Returns a defaulted copy (Ajv `useDefaults`):
 * that copy is what gets stored and rendered. Also runs checks JSON Schema can't express.
 */
export function validateWithSchema(
  compiled: CompiledSchema,
  data: unknown,
): ValidationResult<Record<string, unknown>> {
  const copy: unknown = structuredClone(data);
  if (!compiled.validate(copy)) {
    return { ok: false, issues: ajvErrorsToIssues(compiled.validate.errors) };
  }
  const issues = checkWeeklyHours(compiled.schema, copy, []);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: copy as Record<string, unknown> };
}

/** Every platform:weekly_hours value: ranges ordered, non-empty and non-overlapping. */
function checkWeeklyHours(schema: unknown, data: unknown, path: DocPath): SchemaIssue[] {
  if (!isObject(schema)) return [];
  if (schema[PLATFORM_TYPE_KEYWORD] === "weekly_hours" && isObject(data)) {
    return WEEKDAY_KEYS.flatMap((day) => checkDay(data[day], [...path, day]));
  }
  const issues: SchemaIssue[] = [];
  if (isObject(schema.properties) && isObject(data)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      issues.push(...checkWeeklyHours(sub, data[key], [...path, key]));
    }
  }
  if (isObject(schema.items) && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      issues.push(...checkWeeklyHours(schema.items, item, [...path, i]));
    }
  }
  return issues;
}

function checkDay(ranges: unknown, path: DocPath): SchemaIssue[] {
  if (!Array.isArray(ranges)) return [];
  const issues: SchemaIssue[] = [];
  let previousClose = "";
  for (const [i, range] of (ranges as { open: string; close: string }[]).entries()) {
    if (range.open >= range.close) {
      issues.push({
        path: [...path, i],
        message: `opens at ${range.open} but closes at ${range.close}`,
      });
    } else if (range.open < previousClose) {
      issues.push({
        path: [...path, i],
        message: "overlaps or is out of order; list ranges from earliest to latest",
      });
    }
    previousClose = range.close;
  }
  return issues;
}
