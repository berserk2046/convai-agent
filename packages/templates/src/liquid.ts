import { formatCop } from "@platform/shared";
import { Liquid, type Template as LiquidTemplate } from "liquidjs";
import { DateTime } from "luxon";

/**
 * The only Liquid engine templates run on (spec §10, Appendix B). Strict variables and
 * filters, no file system, a short list of tags, and only the platform's filters. Nothing a
 * template writes can reach the network, disk or database (principle 2).
 */

/** Tags templates may use. Everything else (include, render, layout, cycle…) is removed. */
const ALLOWED_TAGS = new Set([
  "if",
  "unless",
  "case",
  "for",
  "break",
  "continue",
  "assign",
  "capture",
  "comment",
  "raw",
  "echo",
  "liquid",
  "#",
]);

/** Built-in filters kept as-is (Appendix B). `cop` and `date` are ours. */
const KEPT_BUILTIN_FILTERS = new Set(["join", "default", "upcase", "downcase"]);

export const DEFAULT_TIMEZONE = "America/Bogota";

export function createLiquid(): Liquid {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    lenientIf: true,
    ownPropertyOnly: true,
    jsTruthy: false,
    // Empty in-memory template map: include/layout lookups can never touch the disk.
    templates: {},
    // Templates are trusted (platform owner only), but a typo shouldn't hang a worker.
    parseLimit: 100_000,
    renderLimit: 1_000,
    memoryLimit: 10_000_000,
  });

  for (const name of Object.keys(engine.tags)) {
    if (!ALLOWED_TAGS.has(name)) Reflect.deleteProperty(engine.tags, name);
  }
  for (const name of Object.keys(engine.filters)) {
    if (!KEPT_BUILTIN_FILTERS.has(name)) Reflect.deleteProperty(engine.filters, name);
  }

  engine.registerFilter("cop", (value: unknown) => {
    if (value === null || value === undefined || value === "") return "";
    const amount = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(amount)) throw new Error(`cop: not a number: ${JSON.stringify(value)}`);
    return formatCop(amount);
  });

  engine.registerFilter("date", function (value: unknown, format: unknown) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof format !== "string") throw new Error("date: needs a Luxon format string");
    const zone = timezoneFrom(this.context.environments) ?? DEFAULT_TIMEZONE;
    const dt =
      value instanceof Date
        ? DateTime.fromJSDate(value, { zone })
        : typeof value === "string"
          ? DateTime.fromISO(value, { zone })
          : null;
    if (!dt?.isValid) throw new Error(`date: not an ISO date: ${JSON.stringify(value)}`);
    return dt.setLocale("es-CO").toFormat(format);
  });

  return engine;
}

function timezoneFrom(scope: unknown): string | undefined {
  const business = (scope as { business?: { timezone?: unknown } } | null)?.business;
  return typeof business?.timezone === "string" ? business.timezone : undefined;
}

/** Parses and renders with caching of parsed templates (sources are immutable per version). */
export class TemplateRenderer {
  readonly #engine = createLiquid();
  readonly #cache = new Map<string, LiquidTemplate[]>();

  parse(source: string): LiquidTemplate[] {
    let parsed = this.#cache.get(source);
    if (!parsed) {
      parsed = this.#engine.parse(source);
      this.#cache.set(source, parsed);
    }
    return parsed;
  }

  render(source: string, context: Record<string, unknown>): string {
    return this.#engine.renderSync(this.parse(source), context) as string;
  }
}
