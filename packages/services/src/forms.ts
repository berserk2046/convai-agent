import { isObject, type JsonSchema } from "@platform/templates";

/**
 * The setup form's RJSF uiSchema from a config schema's `x-ui` hints (spec §10): order and
 * section per field, help text, names for choices (`labels`), widgets (`textarea`,
 * `weekly-hours`, `table`). Pure, so the admin's form and its tests see the same thing.
 *
 * Field order comes from `source`, the config_schema as the template author wrote it: the
 * stored schema is jsonb, which doesn't keep object keys in order.
 */

export type UiSchema = Record<string, unknown>;

export function uiSchemaFor(schema: JsonSchema, source?: unknown): UiSchema {
  const ui: UiSchema = {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const keys = authorOrder(Object.keys(properties), source);
  const sections: string[] = [];
  for (const key of keys) {
    const section = hints(properties[key]).section;
    if (typeof section === "string" && !sections.includes(section)) sections.push(section);
  }
  const rank = (key: string) => {
    const h = hints(properties[key]);
    const section = typeof h.section === "string" ? sections.indexOf(h.section) : sections.length;
    const order = typeof h.order === "number" ? h.order : Number.MAX_SAFE_INTEGER;
    return [section, order, keys.indexOf(key)] as const;
  };
  ui["ui:order"] = [...keys].sort((a, b) => {
    const [sa, oa, ia] = rank(a);
    const [sb, ob, ib] = rank(b);
    return sa - sb || oa - ob || ia - ib;
  });
  for (const key of keys) {
    const field = fieldUi(properties[key], sourceProperty(source, key));
    if (Object.keys(field).length > 0) ui[key] = field;
  }
  return ui;
}

function fieldUi(schema: unknown, source: unknown): UiSchema {
  if (!isObject(schema)) return {};
  const h = hints(schema);
  const ui: UiSchema = {};
  if (typeof h.help === "string") ui["ui:help"] = h.help;
  // RJSF shows the name and stores the value; a value without a name shows as written.
  if (isObject(h.labels)) ui["ui:enumNames"] = h.labels;
  const options: Record<string, unknown> = {};
  if (typeof h.section === "string") options.section = h.section;
  if (h.widget === "textarea") ui["ui:widget"] = "textarea";
  if (h.widget === "table") {
    options.layout = "table";
    ui["ui:classNames"] = "layout-table";
  }
  if (Object.keys(options).length > 0) ui["ui:options"] = options;
  if (h.widget === "weekly-hours" || schema["x-platform-type"] === "weekly_hours") {
    // A custom field renders the whole week; nothing inside it needs hints.
    return { ...ui, "ui:field": "weeklyHours" };
  }

  if (schema.type === "object" && isObject(schema.properties)) {
    const keys = authorOrder(Object.keys(schema.properties), source);
    if (keys.length > 1) ui["ui:order"] = keys;
    for (const key of keys) {
      const nested = fieldUi(schema.properties[key], sourceProperty(source, key));
      if (Object.keys(nested).length > 0) ui[key] = nested;
    }
  }
  if (schema.type === "array" && isObject(schema.items)) {
    const items = fieldUi(schema.items, isObject(source) ? source.items : undefined);
    if (Object.keys(items).length > 0) ui.items = items;
  }
  return ui;
}

/** The keys in the order the author wrote them, then any the source doesn't list. */
function authorOrder(keys: string[], source: unknown): string[] {
  const written =
    isObject(source) && isObject(source.properties) ? Object.keys(source.properties) : [];
  return [...written.filter((k) => keys.includes(k)), ...keys.filter((k) => !written.includes(k))];
}

function sourceProperty(source: unknown, key: string): unknown {
  return isObject(source) && isObject(source.properties) ? source.properties[key] : undefined;
}

function hints(schema: unknown): Record<string, unknown> {
  return isObject(schema) && isObject(schema["x-ui"]) ? schema["x-ui"] : {};
}
