import type { Context } from "../context.ts";
import type { DocPath, IssueList } from "../issues.ts";
import type { CompiledSchema } from "../json-schema/config-schema.ts";
import { isObject, type JsonSchema } from "../json-schema/platform-types.ts";
import type { TemplateRenderer } from "../liquid.ts";
import type { Template } from "../meta-schema.ts";
import type { Samples } from "./samples.ts";

/** Shared state for the checks of one validation run. */
export interface CheckContext {
  template: Template;
  issues: IssueList;
  renderer: TemplateRenderer;
  /** Null when config_schema doesn't compile; dependent checks are then skipped. */
  config: CompiledSchema | null;
  /** sample_config with defaults applied; null when it doesn't validate. */
  sampleConfig: Record<string, unknown> | null;
  contactFields: CompiledSchema | null;
  /** Null until config and sample_config are valid. */
  samples: Samples | null;
}

export function contactFieldKeys(ctx: CheckContext): string[] {
  return Object.keys(ctx.template.contact_fields ?? {});
}

/** The (resolved) schema of a dotted config path, or undefined if the path doesn't exist. */
export function configFieldSchema(ctx: CheckContext, path: string): JsonSchema | undefined {
  let schema: unknown = ctx.config?.schema;
  for (const part of path.split(".")) {
    if (!isObject(schema) || !isObject(schema.properties)) return undefined;
    schema = schema.properties[part];
  }
  return isObject(schema) ? schema : undefined;
}

/** Whether a top-level config path always has a value (required or defaulted). */
export function configFieldAlwaysSet(ctx: CheckContext, path: string): boolean {
  const field = configFieldSchema(ctx, path);
  if (field && "default" in field) return true;
  const [top, ...rest] = path.split(".");
  const root = ctx.config?.schema;
  return rest.length === 0 && Array.isArray(root?.required) && root.required.includes(top);
}

/** Renders one Liquid string against each context; reports the first failure. */
export function checkLiquid(
  ctx: CheckContext,
  path: DocPath,
  source: string,
  contexts: Context[],
): void {
  try {
    ctx.renderer.parse(source);
  } catch (error) {
    ctx.issues.error(path, `Liquid syntax error: ${liquidMessage(error)}`);
    return;
  }
  for (const context of contexts) {
    try {
      ctx.renderer.render(source, context);
    } catch (error) {
      ctx.issues.error(path, liquidMessage(error));
      return;
    }
  }
}

function liquidMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
