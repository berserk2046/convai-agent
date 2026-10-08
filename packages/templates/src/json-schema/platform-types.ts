import { WEEKDAY_KEYS } from "@platform/shared";
import type { DocPath } from "../issues.ts";

export type JsonSchema = Record<string, unknown>;

const HHMM = "^([01]\\d|2[0-3]):[0-5]\\d$";
const HHMM_OR_24 = "^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$";

const TIME_RANGE: JsonSchema = {
  type: "object",
  required: ["open", "close"],
  additionalProperties: false,
  properties: {
    open: { type: "string", pattern: HHMM },
    close: { type: "string", pattern: HHMM_OR_24 },
  },
};

/** Reusable schema types templates reference with `$ref: "platform:<name>"` (spec §10). */
export const PLATFORM_TYPES: Readonly<Record<string, JsonSchema>> = {
  weekly_hours: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      WEEKDAY_KEYS.map((day) => [day, { type: "array", default: [], items: TIME_RANGE }]),
    ),
  },
  money_cop: { type: "integer", minimum: 0 },
  duration_min: { type: "integer", multipleOf: 5, minimum: 5 },
  // Optional +57, then a 10-digit mobile (3xx) or landline (60x) number.
  phone_co: { type: "string", pattern: "^(\\+57[ -]?)?(3\\d{2}|60\\d)[ -]?\\d{3}[ -]?\\d{4}$" },
  url: { type: "string", format: "uri", pattern: "^https?://" },
};

/** Marks where a platform type was inlined, so later steps can find e.g. weekly hours. */
export const PLATFORM_TYPE_KEYWORD = "x-platform-type";

/** Keywords allowed next to a platform ref. Anything else would change its meaning. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "x-ui",
]);

/** Keys whose values are data, not subschemas. */
const DATA_KEYWORDS = new Set(["default", "examples", "const", "enum", "x-ui"]);

export interface ResolveIssue {
  path: DocPath;
  message: string;
}

/**
 * Replaces every `{ $ref: "platform:x", ...annotations }` with the platform schema plus
 * those annotations. Inlining (instead of registering the refs with Ajv) gives every
 * consumer — Ajv, the admin form generator, field-type checks — one plain schema.
 */
export function resolvePlatformRefs(
  schema: unknown,
  path: DocPath = [],
): { schema: unknown; issues: ResolveIssue[] } {
  const issues: ResolveIssue[] = [];
  const resolved = resolveNode(schema, path, issues);
  return { schema: resolved, issues };
}

function resolveNode(node: unknown, path: DocPath, issues: ResolveIssue[]): unknown {
  if (Array.isArray(node)) return node.map((item, i) => resolveNode(item, [...path, i], issues));
  if (!isObject(node)) return node;

  if (PLATFORM_TYPE_KEYWORD in node) {
    issues.push({
      path: [...path, PLATFORM_TYPE_KEYWORD],
      message: "is reserved for the platform",
    });
  }

  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("platform:")) {
    const name = ref.slice("platform:".length);
    const platformSchema = PLATFORM_TYPES[name];
    if (!platformSchema) {
      issues.push({
        path: [...path, "$ref"],
        message: `unknown platform type "${name}" (known: ${Object.keys(PLATFORM_TYPES).join(", ")})`,
      });
      return node;
    }
    const { $ref: _ref, ...siblings } = node;
    for (const key of Object.keys(siblings)) {
      if (!ANNOTATIONS.has(key)) {
        issues.push({
          path: [...path, key],
          message: `"${key}" can't be combined with ${ref}; only annotations (title, default, x-ui…) can`,
        });
      }
    }
    return { ...structuredClone(platformSchema), ...siblings, [PLATFORM_TYPE_KEYWORD]: name };
  }
  if (typeof ref === "string" && !ref.startsWith("#")) {
    issues.push({
      path: [...path, "$ref"],
      message: `only "platform:<type>" and local "#/..." references are allowed, got "${ref}"`,
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = DATA_KEYWORDS.has(key) ? value : resolveNode(value, [...path, key], issues);
  }
  return out;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
