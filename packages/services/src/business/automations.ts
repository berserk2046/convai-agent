import {
  effectiveTrigger,
  fillBody,
  minutesParam,
  renderText,
  resolveVariables,
  updateAutomationSettings,
} from "@platform/automations/admin";
import {
  countRunsSince,
  listAutomations,
  listResources,
  listWaTemplates,
  type BusinessRow,
} from "@platform/db";
import {
  buildBookingContext,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  getPath,
  isObject,
  metaTemplateName,
  parseSemver,
  type Automation,
  type Context,
  type PreparedTemplate,
} from "@platform/templates";
import { DateTime } from "luxon";
import { ADMIN_ONLY, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { NotFoundError } from "../errors.ts";
import { inBusiness, pinnedTemplate } from "../tenancy.ts";

/**
 * /automations (spec §12): each rule with its description, on/off switch, the timing the
 * template lets the business change, a message preview with sample data, and whether
 * Meta approved its template (a rule whose template isn't approved is blocked).
 */

export interface AutomationView {
  key: string;
  description: string;
  enabled: boolean;
  /** "24 horas antes de la cita". */
  when: string;
  /** Overridable trigger params with their current and template values. */
  timing: { param: string; value: string; templateValue: string; label: string }[];
  /** What the rule does, in words. */
  does: string;
  message: {
    kind: "template" | "text" | "staff";
    preview: string;
    buttons: string[];
    /** WhatsApp template: Meta's name and status; blocked until APPROVED. */
    meta: { name: string; status: string | null; category: string | null } | null;
    blocked: boolean;
  } | null;
  /** Runs in the past 30 days, by outcome. */
  recent: { sent: number; skipped: number; failed: number; scheduled: number };
}

export async function listBusinessAutomations(
  deps: ServiceDeps,
  actor: Actor,
): Promise<AutomationView[]> {
  return inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const { tx, business } = scope;
    const prepared = await pinnedTemplate(scope);
    const rows = await listAutomations(tx, business.id);
    const waRows = await listWaTemplates(tx, business.id);
    const now = deps.now();
    const counts = await countRunsSince(tx, business.id, new Date(now.getTime() - 30 * 86_400_000));
    const resources = await listResources(tx, business.id);
    const context = sampleContext(business, prepared, resources[0]?.name ?? null, now);
    const major = parseSemver(prepared.template.manifest.version)?.major ?? 1;

    return prepared.template.automations.map((rule) => {
      const row = rows.find((r) => r.ruleKey === rule.key);
      const overrides = row?.overrides ?? {};
      const trigger = effectiveTrigger(rule, overrides);
      const recent = { sent: 0, skipped: 0, failed: 0, scheduled: 0 };
      for (const c of counts.filter((c) => c.automationId === row?.id)) recent[c.status] = c.count;
      return {
        key: rule.key,
        description: rule.description,
        enabled: row?.enabled ?? false,
        when: trigger ? describeTrigger(trigger.type, trigger.params, prepared) : rule.trigger.type,
        timing: (rule.overridable ?? []).map((param) => {
          const name = param.slice("trigger.".length);
          return {
            param,
            value: overrides[param] ?? String(rule.trigger[name]),
            templateValue: String(rule.trigger[name]),
            label: TIMING_LABELS[name] ?? name,
          };
        }),
        does: describeAction(rule.action, prepared),
        message: messageOf(rule, prepared, context, waRows, major),
        recent,
      };
    });
  });
}

export async function setAutomationEnabled(
  deps: ServiceDeps,
  actor: Actor,
  ruleKey: string,
  enabled: boolean,
): Promise<void> {
  await inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    await updateAutomationSettings(scope.tx, scope.business.id, ruleKey, { enabled });
    await scope.audit("automation.update", { rule: ruleKey, enabled });
  });
}

/** Changes the rule's timing; only params the template marks overridable (InvalidInputError otherwise). */
export async function setAutomationTiming(
  deps: ServiceDeps,
  actor: Actor,
  ruleKey: string,
  overrides: Record<string, string>,
): Promise<void> {
  await inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const { template } = await pinnedTemplate(scope);
    const rule = template.automations.find((a) => a.key === ruleKey);
    if (!rule) throw new NotFoundError("automation");
    // Values equal to the template's are dropped, so a later template change still applies.
    const kept = Object.fromEntries(
      Object.entries(overrides).filter(
        ([param, value]) =>
          value.trim() !== "" && value !== String(rule.trigger[param.slice("trigger.".length)]),
      ),
    );
    await updateAutomationSettings(scope.tx, scope.business.id, ruleKey, { overrides: kept });
    await scope.audit("automation.update", { rule: ruleKey, overrides: kept });
  });
}

const TIMING_LABELS: Record<string, string> = {
  offset: "Cuándo",
  at_local_time: "Hora del día",
  duration: "Tiempo sin respuesta",
  cron: "Programación",
};

/** "-24h" → "24 horas", "180d" → "180 días": in the unit the template author wrote. */
export function durationLabel(value: unknown): string {
  const match = typeof value === "string" ? /^-?(\d+)(m|h|d)$/.exec(value) : null;
  if (!match) return String(value);
  const n = Number(match[1]);
  const units = { m: ["minuto", "minutos"], h: ["hora", "horas"], d: ["día", "días"] } as const;
  const [one, many] = units[match[2] as "m" | "h" | "d"];
  return `${String(n)} ${n === 1 ? one : many}`;
}

function describeTrigger(
  type: string,
  params: Record<string, unknown>,
  prepared: PreparedTemplate,
): string {
  switch (type) {
    case "booking.starts_in":
      return `${durationLabel(params.offset)} antes de la cita`;
    case "booking.completed": {
      const offset = minutesParam(params, "offset");
      return offset === 0
        ? "Al terminar la cita"
        : `${durationLabel(params.offset)} después de terminar la cita`;
    }
    case "booking.created":
      return "Al crear una cita";
    case "booking.rescheduled":
      return "Al mover una cita";
    case "booking.cancelled":
      return "Al cancelar una cita";
    case "contact.date_field": {
      const field = String(params.field);
      const title = prepared.template.contact_fields?.[field]?.title;
      const offset = minutesParam(params, "offset");
      const relation = offset < 0 ? "antes de" : "después de";
      return `${durationLabel(params.offset)} ${relation} «${typeof title === "string" ? title : field}», a las ${String(params.at_local_time)}`;
    }
    case "conversation.inactive":
      return `Tras ${durationLabel(params.duration)} sin mensajes del cliente`;
    case "schedule":
      return `Programado (cron ${String(params.cron)})`;
    default:
      return type;
  }
}

function describeAction(action: Automation["action"], prepared: PreparedTemplate): string {
  const { type, ...params } = action;
  switch (type) {
    case "send_template":
      return "Envía un mensaje de WhatsApp (plantilla aprobada por Meta)";
    case "send_text":
      return "Envía un mensaje de texto (solo si el cliente escribió en las últimas 24 horas)";
    case "update_booking":
      return (params.set as { status?: string } | undefined)?.status === "cancelled"
        ? "Cancela la cita"
        : "Marca la cita como confirmada";
    case "update_contact": {
      const fields = Object.keys((params.set ?? {}) as Record<string, unknown>).map((f) => {
        const title = prepared.template.contact_fields?.[f]?.title;
        return `«${typeof title === "string" ? title : f}»`;
      });
      return `Actualiza ${fields.join(", ")} del cliente`;
    }
    case "notify_staff":
      return "Avisa al equipo en la bandeja de entrada";
    case "start_agent":
      return "Pasa la conversación al asistente";
    default:
      return type;
  }
}

function messageOf(
  rule: Automation,
  prepared: PreparedTemplate,
  context: Context,
  waRows: Awaited<ReturnType<typeof listWaTemplates>>,
  major: number,
): AutomationView["message"] {
  const { type, ...params } = rule.action;
  if (type === "send_template") {
    const wa = prepared.template.wa_templates.find((t) => t.key === params.template);
    if (!wa) return null;
    const resolved = resolveVariables(wa, context);
    const name = metaTemplateName(wa.key, major);
    const row = waRows.find((r) => r.metaName === name && r.language === wa.language);
    return {
      kind: "template",
      preview: fillBody(wa.body, resolved.ok ? resolved.values : wa.examples),
      buttons: wa.buttons.map((b) => b.text),
      meta: {
        name,
        status: row?.metaStatus ?? null,
        category: row?.categoryMeta ?? row?.categoryRequested ?? wa.category,
      },
      blocked: row?.metaStatus !== "APPROVED",
    };
  }
  if (type === "send_text" || type === "notify_staff") {
    return {
      kind: type === "send_text" ? "text" : "staff",
      preview: renderText(String(params.text), context),
      buttons: [],
      meta: null,
      blocked: false,
    };
  }
  return null;
}

/**
 * Sample data for previews: the business's real config, a patient called Laura Gómez with
 * every contact field filled, and a booking tomorrow at 10:00 for the first bookable service.
 */
function sampleContext(
  business: BusinessRow,
  prepared: PreparedTemplate,
  resourceName: string | null,
  now: Date,
): Context {
  const zone = business.timezone;
  const config = business.config ?? {};
  const local = DateTime.fromJSDate(now, { zone });
  const catalogPath = String(prepared.template.booking?.catalog_path ?? "services");
  const catalog = getPath(config, catalogPath);
  const service = (Array.isArray(catalog) ? catalog.filter(isObject) : []).find(
    (s) => s.bookable !== false,
  );
  const start = local.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const booking = {
    id: "00000000-0000-4000-8000-000000000000",
    service_key: typeof service?.key === "string" ? service.key : "servicio",
    service_name: typeof service?.name === "string" ? service.name : "Servicio",
    subject_name: "Laura Gómez",
    party_size: 2,
    status: "pending",
    source: "agent",
    starts_at: start,
    ends_at: start.plus({
      minutes: typeof service?.duration_min === "number" ? service.duration_min : 30,
    }),
    resource_name: resourceName,
    notes: null,
  };
  const fieldKeys = Object.keys(prepared.template.contact_fields ?? {});
  return {
    business: buildBusinessContext(config, prepared.config.schema, zone),
    now: buildNowContext(local, business.holidays.open_holidays),
    contact: buildContactContext(
      {
        name: "Laura Gómez",
        fields: Object.fromEntries(fieldKeys.map((k) => [k, sampleField(prepared, k, local)])),
        upcomingBookings: [booking],
      },
      fieldKeys,
    ),
    booking: buildBookingContext(booking),
  };
}

function sampleField(prepared: PreparedTemplate, key: string, local: DateTime): unknown {
  const schema = prepared.template.contact_fields?.[key];
  if (schema?.format === "date") return local.minus({ months: 6 }).toISODate();
  if (schema?.type === "boolean") return false;
  return "Ejemplo";
}
