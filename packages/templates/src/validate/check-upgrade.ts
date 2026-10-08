import { validateWithSchema } from "../json-schema/config-schema.ts";
import type { Template, WaTemplate } from "../meta-schema.ts";
import { compareSemver, parseSemver } from "../semver.ts";
import { metaTemplateName } from "../wa-rules.ts";
import type { CheckContext } from "./check-context.ts";

/**
 * Lifecycle rules against the previous version (spec §10, decision A16): versions only go
 * up; within a major version, existing configs stay valid and Meta templates only get text
 * edits (changing variables, buttons, category or language needs a major bump).
 */
export function checkUpgrade(ctx: CheckContext, previous: Template): void {
  const next = ctx.template;
  if (previous.manifest.slug !== next.manifest.slug) {
    ctx.issues.error(
      ["manifest", "slug"],
      `differs from the previous version's slug "${previous.manifest.slug}"`,
    );
    return;
  }
  if (compareSemver(next.manifest.version, previous.manifest.version) <= 0) {
    ctx.issues.error(
      ["manifest", "version"],
      `must be greater than the previous version ${previous.manifest.version}`,
    );
    return;
  }
  const major = parseSemver(next.manifest.version)?.major ?? 0;
  if (major !== parseSemver(previous.manifest.version)?.major) return;

  if (ctx.config) {
    const result = validateWithSchema(ctx.config, previous.sample_config);
    if (!result.ok) {
      for (const issue of result.issues) {
        ctx.issues.error(
          ["config_schema"],
          `breaks configs that were valid in ${previous.manifest.version} (sample_config.${issue.path.join(".")} ${issue.message}); that needs a major version`,
        );
      }
    }
  }

  for (const old of previous.wa_templates) {
    const index = next.wa_templates.findIndex((t) => t.key === old.key);
    const name = metaTemplateName(old.key, major);
    const current = next.wa_templates[index];
    if (!current) {
      ctx.issues.error(
        ["wa_templates"],
        `removes "${old.key}" (Meta template ${name}); that needs a major version`,
      );
      continue;
    }
    for (const field of incompatibleChanges(old, current)) {
      ctx.issues.error(
        ["wa_templates", index, field],
        `changed in a minor version; Meta template ${name} can only get text edits, so bump the major version`,
      );
    }
    if (old.body !== current.body) {
      ctx.issues.warning(
        ["wa_templates", index, "body"],
        `changed; Meta template ${name} will be edited and re-reviewed`,
      );
    }
  }

  for (const old of previous.automations) {
    if (!next.automations.some((a) => a.key === old.key)) {
      ctx.issues.warning(
        ["automations"],
        `removes "${old.key}"; businesses lose that automation and its settings`,
      );
    }
  }
}

function incompatibleChanges(old: WaTemplate, current: WaTemplate): string[] {
  const changed: string[] = [];
  if (old.category !== current.category) changed.push("category");
  if (old.language !== current.language) changed.push("language");
  if (old.variables.length !== current.variables.length) changed.push("variables");
  const buttons = (t: WaTemplate) => JSON.stringify(t.buttons.map((b) => [b.text, b.payload]));
  if (buttons(old) !== buttons(current)) changed.push("buttons");
  return changed;
}
