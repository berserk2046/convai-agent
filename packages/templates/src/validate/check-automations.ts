import {
  ACTIONS,
  BOOKING_STATUSES,
  TRIGGERS,
  type ActionDeclaration,
  type ActionType,
  type SubjectType,
  type TriggerType,
} from "../capabilities.ts";
import { BOOKING_CONTEXT_FIELDS, getPath, type Context } from "../context.ts";
import type { DocPath } from "../issues.ts";
import { createAjv } from "../json-schema/ajv.ts";
import { isObject } from "../json-schema/platform-types.ts";
import type { Automation, AutomationAction, Condition, WaTemplate } from "../meta-schema.ts";
import { checkWaTemplate } from "../wa-rules.ts";
import {
  checkLiquid,
  configFieldSchema,
  contactFieldKeys,
  type CheckContext,
} from "./check-context.ts";
import { addZodIssues } from "./zod-issues.ts";

/** Rule 8: Meta's template rules, unique keys. */
export function checkWaTemplates(ctx: CheckContext): void {
  const seen = new Set<string>();
  for (const [i, template] of ctx.template.wa_templates.entries()) {
    if (seen.has(template.key))
      ctx.issues.error(["wa_templates", i, "key"], `"${template.key}" is used twice`);
    seen.add(template.key);
    for (const issue of checkWaTemplate(template)) {
      const path = ["wa_templates", i, ...issue.path];
      if (issue.severity === "error") ctx.issues.error(path, issue.message);
      else ctx.issues.warning(path, issue.message);
    }
  }
}

/** Rule 7: triggers, conditions and actions exist and reference real things. */
export function checkAutomations(ctx: CheckContext): void {
  const { automations, wa_templates: waTemplates, manifest } = ctx.template;
  const keys = automations.map((a) => a.key);
  const usedTemplates = new Set<string>();

  for (const [i, automation] of automations.entries()) {
    const path: DocPath = ["automations", i];
    if (keys.indexOf(automation.key) !== i)
      ctx.issues.error([...path, "key"], `"${automation.key}" is used twice`);

    const subject = checkTrigger(ctx, automation, path);
    if (
      !manifest.capabilities.triggers.includes(automation.trigger.type) &&
      automation.trigger.type in TRIGGERS
    ) {
      ctx.issues.error(
        ["manifest", "capabilities", "triggers"],
        `must declare "${automation.trigger.type}", which automation ${automation.key} uses`,
      );
    }
    automation.conditions.forEach((c, j) => {
      checkCondition(ctx, c, [...path, "conditions", j], subject, keys, automation.key);
    });

    checkAction(ctx, automation.action, [...path, "action"], subject, usedTemplates);
    for (const [payload, actions] of Object.entries(automation.on_button ?? {})) {
      actions.forEach((a, k) => {
        checkAction(ctx, a, [...path, "on_button", payload, k], subject, usedTemplates);
      });
    }
    checkButtons(ctx, automation, path, waTemplates);
    checkOverridable(ctx, automation, path);
  }

  for (const [i, template] of waTemplates.entries()) {
    if (!usedTemplates.has(template.key)) {
      ctx.issues.warning(
        ["wa_templates", i, "key"],
        `"${template.key}" is not used by any automation`,
      );
    }
  }
}

function checkTrigger(
  ctx: CheckContext,
  automation: Automation,
  path: DocPath,
): SubjectType | null {
  const { type, ...params } = automation.trigger;
  if (!(type in TRIGGERS)) {
    ctx.issues.error(
      [...path, "trigger", "type"],
      `unknown trigger "${type}" (known: ${Object.keys(TRIGGERS).join(", ")})`,
    );
    return null;
  }
  const declaration = TRIGGERS[type as TriggerType];
  const parsed = declaration.params.safeParse(params);
  if (!parsed.success) addZodIssues(ctx.issues, parsed.error, [...path, "trigger"]);

  if (type === "contact.date_field" && typeof params.field === "string") {
    const field = ctx.template.contact_fields?.[params.field];
    if (!field) {
      ctx.issues.error([...path, "trigger", "field"], `"${params.field}" is not in contact_fields`);
    } else if (field.format !== "date") {
      ctx.issues.error(
        [...path, "trigger", "field"],
        `contact field "${params.field}" must have format: date`,
      );
    }
  }
  return declaration.subject;
}

function checkCondition(
  ctx: CheckContext,
  condition: Condition,
  path: DocPath,
  subject: SubjectType | null,
  ruleKeys: string[],
  ownKey: string,
): void {
  if (condition.builtin === "run_sent" && condition.rule !== undefined) {
    if (!ruleKeys.includes(condition.rule) || condition.rule === ownKey) {
      ctx.issues.error(
        [...path, "rule"],
        `"${condition.rule}" is not another automation in this template`,
      );
    }
    return;
  }
  if (condition.field === undefined) return;

  const [scope, ...rest] = condition.field.split(".");
  const field = rest.join(".");
  const fieldPath = [...path, "field"];
  if (scope === "booking") {
    if (subject !== "booking") {
      ctx.issues.error(
        fieldPath,
        "booking fields are only available when the trigger's subject is a booking",
      );
    } else if (!(BOOKING_CONTEXT_FIELDS as readonly string[]).includes(field)) {
      ctx.issues.error(
        fieldPath,
        `unknown booking field "${field}" (known: ${BOOKING_CONTEXT_FIELDS.join(", ")})`,
      );
    }
  } else if (scope === "contact") {
    if (field !== "name" && !contactFieldKeys(ctx).includes(field)) {
      ctx.issues.error(fieldPath, `"${field}" is not a contact field (name or contact_fields)`);
    }
  } else if (scope === "business") {
    if (ctx.config && !configFieldSchema(ctx, field)) {
      ctx.issues.error(fieldPath, `"${field}" is not in config_schema`);
    }
  } else {
    ctx.issues.error(fieldPath, 'must start with "booking.", "contact." or "business."');
  }

  const values = condition.in ?? (condition.eq === undefined ? [] : [condition.eq]);
  const valuesPath = [...path, condition.in ? "in" : "eq"];
  if (condition.field === "booking.status") {
    for (const value of values) {
      if (!(BOOKING_STATUSES as readonly unknown[]).includes(value)) {
        ctx.issues.error(
          valuesPath,
          `"${String(value)}" is not a booking status (${BOOKING_STATUSES.join(", ")})`,
        );
      }
    }
  }
  if (condition.field === "booking.service_key" && ctx.samples?.rules && ctx.sampleConfig) {
    const catalog = getPath(ctx.sampleConfig, ctx.samples.rules.catalog_path);
    const known = Array.isArray(catalog) ? catalog.filter(isObject).map((s) => s.key) : [];
    for (const value of values) {
      if (!known.includes(value)) {
        ctx.issues.warning(
          valuesPath,
          `"${String(value)}" is not a service in sample_config; businesses must use this key for the rule to fire`,
        );
      }
    }
  }
}

function checkAction(
  ctx: CheckContext,
  action: AutomationAction,
  path: DocPath,
  subject: SubjectType | null,
  usedTemplates: Set<string>,
): void {
  const { type, ...params } = action;
  if (!(type in ACTIONS)) {
    ctx.issues.error(
      [...path, "type"],
      `unknown action "${type}" (known: ${Object.keys(ACTIONS).join(", ")})`,
    );
    return;
  }
  const declaration: ActionDeclaration = ACTIONS[type as ActionType];
  const parsed = declaration.params.safeParse(params);
  if (!parsed.success) {
    addZodIssues(ctx.issues, parsed.error, path);
    return;
  }
  if (subject && declaration.subjects && !declaration.subjects.includes(subject)) {
    ctx.issues.error(
      [...path, "type"],
      `${type} needs a ${declaration.subjects.join("/")} trigger, not a ${subject} one`,
    );
  }
  const contexts: Context[] = subject && ctx.samples ? ctx.samples.automation[subject] : [];
  for (const name of declaration.liquidParams) {
    const value = params[name];
    if (typeof value === "string" && contexts.length > 0)
      checkLiquid(ctx, [...path, name], value, contexts);
  }

  if (type === "send_template" && typeof params.template === "string") {
    usedTemplates.add(params.template);
    const template = ctx.template.wa_templates.find((t) => t.key === params.template);
    if (!template) {
      ctx.issues.error(
        [...path, "template"],
        `"${params.template}" is not declared in wa_templates`,
      );
    } else {
      checkTemplateVariables(ctx, template, contexts, subject);
    }
  }
  if (type === "update_contact" && isObject(params.set)) {
    checkContactUpdate(ctx, params.set, [...path, "set"], contexts);
  }
}

/** Every message variable must resolve in the context of every automation that sends it. */
function checkTemplateVariables(
  ctx: CheckContext,
  template: WaTemplate,
  contexts: Context[],
  subject: SubjectType | null,
): void {
  const sample = contexts[0];
  if (!sample) return;
  const index = ctx.template.wa_templates.indexOf(template);
  template.variables.forEach((variable, i) => {
    const paths = typeof variable === "string" ? [variable] : variable.paths;
    for (const path of paths) {
      if (getPath(sample, path) === undefined) {
        ctx.issues.error(
          ["wa_templates", index, "variables", i],
          `"${path}" is not available when sent from a ${subject ?? "unknown"} trigger`,
        );
      }
    }
  });
}

/** update_contact: known fields; Liquid values render and fit the field's schema. */
function checkContactUpdate(
  ctx: CheckContext,
  set: Record<string, unknown>,
  path: DocPath,
  contexts: Context[],
): void {
  const properties = isObject(ctx.contactFields?.schema.properties)
    ? ctx.contactFields.schema.properties
    : {};
  for (const [field, value] of Object.entries(set)) {
    const fieldSchema = properties[field];
    if (!isObject(fieldSchema)) {
      ctx.issues.error([...path, field], `"${field}" is not in contact_fields`);
      continue;
    }
    let sample: unknown = value;
    if (typeof value === "string" && contexts[0]) {
      const before = ctx.issues.errorCount;
      checkLiquid(ctx, [...path, field], value, contexts);
      if (ctx.issues.errorCount > before) continue;
      sample = ctx.renderer.render(value, contexts[0]);
    }
    const validate = createAjv().compile(fieldSchema);
    if (!validate(sample)) {
      ctx.issues.error(
        [...path, field],
        `renders ${JSON.stringify(sample)}, which ${validate.errors?.[0]?.message ?? "is invalid"} for contact field "${field}"`,
      );
    }
  }
}

/** on_button handlers must match buttons of the template the rule sends. */
function checkButtons(
  ctx: CheckContext,
  automation: Automation,
  path: DocPath,
  templates: readonly WaTemplate[],
): void {
  const sent = automation.action.type === "send_template" ? automation.action.template : undefined;
  const template = templates.find((t) => t.key === sent);
  const payloads = template?.buttons.map((b) => b.payload) ?? [];
  for (const payload of Object.keys(automation.on_button ?? {})) {
    if (!payloads.includes(payload)) {
      ctx.issues.error(
        [...path, "on_button", payload],
        template
          ? `"${payload}" is not a button payload of ${template.key} (${payloads.join(", ") || "it has no buttons"})`
          : "on_button needs an action that sends a template with buttons",
      );
    }
  }
  for (const payload of payloads) {
    if (!automation.on_button?.[payload]) {
      ctx.issues.warning(
        [...path, "on_button"],
        `button "${payload}" has no handler; tapping it will reach the agent`,
      );
    }
  }
}

/** overridable: only existing trigger params (timing) can be overridden per business. */
function checkOverridable(ctx: CheckContext, automation: Automation, path: DocPath): void {
  for (const [i, entry] of (automation.overridable ?? []).entries()) {
    const [head, param] = entry.split(".");
    if (
      head !== "trigger" ||
      param === undefined ||
      param === "type" ||
      entry.split(".").length !== 2
    ) {
      ctx.issues.error(
        [...path, "overridable", i],
        `"${entry}" can't be overridden; only trigger params like trigger.offset can`,
      );
    } else if (!(param in automation.trigger)) {
      ctx.issues.error([...path, "overridable", i], `"${entry}" is not set on this trigger`);
    }
  }
}
