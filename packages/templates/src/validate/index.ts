import { IssueList, formatPath, type Issue } from "../issues.ts";
import { TemplateRenderer } from "../liquid.ts";
import { templateSchema, type Template } from "../meta-schema.ts";
import {
  checkAgentLiquid,
  checkBookingRules,
  checkPriceGuard,
  checkRegexes,
  checkTools,
} from "./check-agent.ts";
import { checkAutomations, checkWaTemplates } from "./check-automations.ts";
import {
  checkConfigSchema,
  checkContactFields,
  checkManifest,
  type ManifestOptions,
} from "./check-config.ts";
import type { CheckContext } from "./check-context.ts";
import { checkEvals } from "./check-evals.ts";
import { checkUpgrade } from "./check-upgrade.ts";
import { buildSamples } from "./samples.ts";
import { parseYamlSource } from "./yaml-source.ts";
import { addZodIssues } from "./zod-issues.ts";

export interface ValidateOptions extends ManifestOptions {
  /** The latest published version of the same slug, for upgrade rules. */
  previous?: Template;
}

export interface ValidationReport {
  /** True when there are no errors (warnings are allowed). */
  ok: boolean;
  /** The parsed template, when it at least matches the meta-schema. */
  template: Template | null;
  issues: Issue[];
}

/** Validates a template's YAML source against every rule in spec §10. */
export function validateTemplateSource(
  source: string,
  options: ValidateOptions = {},
): ValidationReport {
  const parsed = parseYamlSource(source);
  if (parsed.errors.length > 0) {
    const issues = parsed.errors.map((e): Issue => ({
      severity: "error",
      path: "",
      message: `YAML: ${e.message}`,
      ...(e.line === undefined ? {} : { line: e.line }),
    }));
    return { ok: false, template: null, issues };
  }

  const list = new IssueList();
  const report = (template: Template | null): ValidationReport => ({
    ok: !list.hasErrors,
    template,
    issues: list.entries.map((entry) => {
      const line = parsed.lineOf(entry.path);
      return {
        severity: entry.severity,
        path: formatPath(entry.path),
        message: entry.message,
        ...(line === undefined ? {} : { line }),
      };
    }),
  });

  // Rule 1: the meta-schema. Nothing else is reliable until the shape is right.
  const shape = templateSchema.safeParse(parsed.value);
  if (!shape.success) {
    addZodIssues(list, shape.error);
    return report(null);
  }

  const ctx: CheckContext = {
    template: shape.data,
    issues: list,
    renderer: new TemplateRenderer(),
    config: null,
    sampleConfig: null,
    contactFields: null,
    samples: null,
  };

  checkManifest(ctx, options);
  checkConfigSchema(ctx);
  checkContactFields(ctx);
  if (ctx.config && ctx.sampleConfig) {
    ctx.samples = buildSamples(
      ctx.template,
      ctx.config.schema,
      ctx.sampleConfig,
      ctx.contactFields?.schema ?? null,
    );
  }
  checkTools(ctx);
  checkBookingRules(ctx);
  checkPriceGuard(ctx);
  checkRegexes(ctx);
  checkAgentLiquid(ctx);
  checkWaTemplates(ctx);
  checkAutomations(ctx);
  checkEvals(ctx);
  if (options.previous) checkUpgrade(ctx, options.previous);

  return report(ctx.template);
}
