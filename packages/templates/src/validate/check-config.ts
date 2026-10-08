import { PLATFORM_VERSION, TOOLS, TRIGGERS } from "../capabilities.ts";
import { RESERVED_CONTACT_KEYS, computedBusinessKeys } from "../context.ts";
import { compileObjectSchema, validateWithSchema } from "../json-schema/config-schema.ts";
import { compareSemver } from "../semver.ts";
import type { CheckContext } from "./check-context.ts";

export interface ManifestOptions {
  /** Versions of this slug already published; uploading one again is refused. */
  publishedVersions?: readonly string[];
}

export function checkManifest(ctx: CheckContext, options: ManifestOptions): void {
  const { manifest } = ctx.template;
  if (compareSemver(manifest.min_platform_version, PLATFORM_VERSION) > 0) {
    ctx.issues.error(
      ["manifest", "min_platform_version"],
      `needs platform ${manifest.min_platform_version}, but this platform is ${PLATFORM_VERSION}`,
    );
  }
  if (options.publishedVersions?.includes(manifest.version)) {
    ctx.issues.error(
      ["manifest", "version"],
      `${manifest.slug}@${manifest.version} is already published`,
    );
  }

  const usedTools = Object.keys(ctx.template.agent.tools);
  const usedTriggers = ctx.template.automations.map((a) => a.trigger.type);
  for (const [i, tool] of manifest.capabilities.tools.entries()) {
    if (!(tool in TOOLS))
      ctx.issues.error(["manifest", "capabilities", "tools", i], `unknown tool "${tool}"`);
    else if (!usedTools.includes(tool)) {
      ctx.issues.warning(
        ["manifest", "capabilities", "tools", i],
        `"${tool}" is declared but not enabled in agent.tools`,
      );
    }
  }
  for (const [i, trigger] of manifest.capabilities.triggers.entries()) {
    if (!(trigger in TRIGGERS)) {
      ctx.issues.error(["manifest", "capabilities", "triggers", i], `unknown trigger "${trigger}"`);
    } else if (!usedTriggers.includes(trigger)) {
      ctx.issues.warning(
        ["manifest", "capabilities", "triggers", i],
        `"${trigger}" is declared but no automation uses it`,
      );
    }
  }
}

/** Rules 3–4: config_schema is a valid JSON Schema and sample_config satisfies it. */
export function checkConfigSchema(ctx: CheckContext): void {
  const result = compileObjectSchema(ctx.template.config_schema);
  if (!result.compiled) {
    for (const issue of result.issues)
      ctx.issues.error(["config_schema", ...issue.path], issue.message);
    return;
  }
  ctx.config = result.compiled;

  const properties = Object.keys(result.compiled.schema.properties ?? {});
  for (const key of computedBusinessKeys(result.compiled.schema)) {
    if (properties.includes(key)) {
      ctx.issues.error(
        ["config_schema", "properties", key],
        `"${key}" is reserved: the platform computes business.${key}`,
      );
    }
  }

  const sample = validateWithSchema(result.compiled, ctx.template.sample_config);
  if (!sample.ok) {
    for (const issue of sample.issues)
      ctx.issues.error(["sample_config", ...issue.path], issue.message);
    return;
  }
  ctx.sampleConfig = sample.value;
}

/** contact_fields: valid field schemas, safe names. */
export function checkContactFields(ctx: CheckContext): void {
  const fields = ctx.template.contact_fields;
  if (!fields) return;
  for (const key of Object.keys(fields)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      ctx.issues.error(
        ["contact_fields", key],
        "must be lowercase letters, digits and underscores",
      );
    } else if ((RESERVED_CONTACT_KEYS as readonly string[]).includes(key)) {
      ctx.issues.error(
        ["contact_fields", key],
        `"${key}" is reserved for the platform's own contact data`,
      );
    }
  }
  const result = compileObjectSchema({
    type: "object",
    additionalProperties: false,
    properties: fields,
  });
  if (!result.compiled) {
    for (const issue of result.issues) {
      // Drop the wrapper's "properties" segment so paths match the template.
      const path = issue.path[0] === "properties" ? issue.path.slice(1) : issue.path;
      ctx.issues.error(["contact_fields", ...path], issue.message);
    }
    return;
  }
  ctx.contactFields = result.compiled;
}
