import { WhatsAppSendError } from "./errors.ts";
import { graphRequest, type GraphOptions } from "./graph.ts";

/**
 * Message template management (spec §9), from Meta's template docs fetched 2026-10-08:
 * - create: POST /{waba-id}/message_templates with name, language, category,
 *   parameter_format and components; answers { id, status, category };
 * - edit: POST /{template-id} with new components (they replace all old ones); answers
 *   { success: true }. Only APPROVED, REJECTED or PAUSED templates can be edited;
 * - list: GET /{waba-id}/message_templates?fields=…, paged with cursors.
 */

/** Error subcode when a template with this name and language already exists. */
export const TEMPLATE_EXISTS_SUBCODE = 2388024;

export interface WabaAuth {
  wabaId: string;
  /** Decrypted channel token; used for this request only, never logged. */
  accessToken: string;
}

export interface NewMetaTemplate {
  name: string;
  language: string;
  category: string;
  components: readonly Record<string, unknown>[];
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string | null;
  category: string | null;
  components: Record<string, unknown>[];
}

export interface TemplateApi {
  create(
    auth: WabaAuth,
    template: NewMetaTemplate,
  ): Promise<{ id: string; status: string | null; category: string | null }>;
  edit(
    accessToken: string,
    templateId: string,
    components: readonly Record<string, unknown>[],
  ): Promise<void>;
  /** Every template of the account (all pages). */
  list(auth: WabaAuth): Promise<MetaTemplate[]>;
}

const LIST_FIELDS = "id,name,language,status,category,components";
const MAX_PAGES = 20;

export function createTemplateApi(options: GraphOptions): TemplateApi {
  return {
    async create(auth, template) {
      const { json } = await graphRequest(options, {
        method: "POST",
        path: `/${encodeURIComponent(auth.wabaId)}/message_templates`,
        accessToken: auth.accessToken,
        body: {
          name: template.name,
          language: template.language,
          // Meta's creation examples write the category in lowercase.
          category: template.category.toLowerCase(),
          // Our bodies use {{1}}…{{n}} (spec §10, rule 8).
          parameter_format: "positional",
          components: template.components,
        },
      });
      if (typeof json?.id !== "string") {
        throw new WhatsAppSendError("Meta created no template id", { kind: "unknown" });
      }
      return {
        id: json.id,
        status: typeof json.status === "string" ? json.status : null,
        category: typeof json.category === "string" ? json.category : null,
      };
    },

    async edit(accessToken, templateId, components) {
      const { json } = await graphRequest(options, {
        method: "POST",
        path: `/${encodeURIComponent(templateId)}`,
        accessToken,
        body: { components },
      });
      if (json?.success !== true) {
        throw new WhatsAppSendError("Meta did not confirm the template edit", { kind: "unknown" });
      }
    },

    async list(auth) {
      const out: MetaTemplate[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { json } = await graphRequest(options, {
          method: "GET",
          path: `/${encodeURIComponent(auth.wabaId)}/message_templates`,
          accessToken: auth.accessToken,
          query: { fields: LIST_FIELDS, limit: "100", ...(after ? { after } : {}) },
        });
        const data = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
        out.push(...data.flatMap(toMetaTemplate));
        const paging = (json?.paging ?? {}) as { next?: unknown; cursors?: { after?: unknown } };
        after = typeof paging.cursors?.after === "string" ? paging.cursors.after : null;
        if (typeof paging.next !== "string" || after === null) break;
      }
      return out;
    },
  };
}

function toMetaTemplate(item: Record<string, unknown>): MetaTemplate[] {
  if (typeof item.id !== "string" || typeof item.name !== "string") return [];
  return [
    {
      id: item.id,
      name: item.name,
      language: typeof item.language === "string" ? item.language : "",
      status: typeof item.status === "string" ? item.status : null,
      category: typeof item.category === "string" ? item.category : null,
      components: Array.isArray(item.components)
        ? (item.components as Record<string, unknown>[])
        : [],
    },
  ];
}
