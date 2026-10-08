import {
  compileObjectSchema,
  validateWithSchema,
  type CompiledSchema,
  type ValidationResult,
} from "./json-schema/config-schema.ts";
import type { Template } from "./meta-schema.ts";

/** A validated template with its schemas compiled, ready to serve businesses. */
export interface PreparedTemplate {
  template: Template;
  config: CompiledSchema;
  contactFields: CompiledSchema | null;
}

/**
 * Compiles a template that already passed validation. Throws if its schemas don't compile,
 * which means it never went through the validator.
 */
export function prepareTemplate(template: Template): PreparedTemplate {
  const config = compileObjectSchema(template.config_schema);
  if (!config.compiled) {
    throw new Error(
      `${template.manifest.slug}@${template.manifest.version}: config_schema does not compile`,
    );
  }
  let contactFields: CompiledSchema | null = null;
  if (template.contact_fields) {
    const result = compileObjectSchema({
      type: "object",
      additionalProperties: false,
      properties: template.contact_fields,
    });
    if (!result.compiled) {
      throw new Error(
        `${template.manifest.slug}@${template.manifest.version}: contact_fields do not compile`,
      );
    }
    contactFields = result.compiled;
  }
  return { template, config: config.compiled, contactFields };
}

/**
 * Validates a business config against its pinned template (spec §6: on every write).
 * On success returns the config with schema defaults applied; store that copy.
 */
export function validateBusinessConfig(
  prepared: PreparedTemplate,
  config: unknown,
): ValidationResult<Record<string, unknown>> {
  return validateWithSchema(prepared.config, config);
}
