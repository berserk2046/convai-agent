import {
  createClosure,
  createResource,
  preparedTemplateFor,
  deleteClosure,
  listClosures,
  listResources,
  setHolidayOpen,
  updateBusinessConfig,
  updateResource,
} from "@platform/db";
import { COLOMBIAN_HOLIDAYS, holidaysBetween } from "@platform/shared";
import {
  TemplateRenderer,
  agentSettings,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  tidy,
  validateBusinessConfig,
  type JsonSchema,
} from "@platform/templates";
import { DateTime } from "luxon";
import { ADMIN_ONLY, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";
import { uiSchemaFor, type UiSchema } from "../forms.ts";
import {
  authoredConfigSchema,
  inBusiness,
  pinnedRow,
  pinnedTemplate,
  stableJson,
} from "../tenancy.ts";
import { dayLabel, parseLocal, slotLabel, toLocalInput } from "../time.ts";

/**
 * /setup (spec §12): the config form generated from the pinned template, resources,
 * closures, public holidays (C2) and a preview of the consent message. Business admins
 * only (staff block time from /bookings).
 */

export interface SetupView {
  business: { name: string; status: string; timezone: string };
  form: { schema: JsonSchema; uiSchema: UiSchema; config: Record<string, unknown> };
  /** The template's bookable resource, e.g. { kind: "chair", label: "Sillón" }. */
  resourceType: { kind: string; label: string } | null;
  resources: { id: string; name: string; capacity: number | null; active: boolean }[];
  closures: {
    id: string;
    resourceName: string | null;
    from: string;
    to: string;
    reason: string | null;
  }[];
  holidays: { key: string; name: string; next: string | null; open: boolean }[];
  /** The consent message as customers read it now; null until the config is saved. */
  consentPreview: string | null;
}

export interface FieldError {
  /** Path into the config, e.g. ["services", 0, "price_cop"]. */
  path: (string | number)[];
  message: string;
}

export async function getSetup(deps: ServiceDeps, actor: Actor): Promise<SetupView> {
  return inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const { business, tx } = scope;
    const row = await pinnedRow(scope);
    const prepared = preparedTemplateFor(row);
    const { template } = prepared;
    const zone = business.timezone;
    const now = deps.now();
    const resources = await listResources(tx, business.id);
    const closures = await listClosures(
      tx,
      business.id,
      new Date(now.getTime() - 7 * 86_400_000),
      new Date(now.getTime() + 400 * 86_400_000),
    );
    const local = DateTime.fromJSDate(now, { zone });
    const upcoming = holidaysBetween(
      local.toISODate() ?? "",
      local.plus({ years: 1 }).toISODate() ?? "",
    );
    const open = new Set(business.holidays.open_holidays ?? []);

    return {
      business: { name: business.name, status: business.status, timezone: zone },
      form: {
        schema: prepared.config.schema,
        uiSchema: uiSchemaFor(prepared.config.schema, authoredConfigSchema(row)),
        config: business.config ?? {},
      },
      resourceType: template.booking
        ? {
            kind: String(template.booking.resource_kind),
            label: String(template.booking.resource_label),
          }
        : null,
      resources: resources.map(({ id, name, capacity, active }) => ({
        id,
        name,
        capacity,
        active,
      })),
      closures: closures
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map((c) => ({
          id: c.id,
          resourceName: resources.find((r) => r.id === c.resourceId)?.name ?? null,
          from: slotLabel(c.startsAt, zone),
          to: slotLabel(c.endsAt, zone),
          reason: c.reason,
        })),
      holidays: COLOMBIAN_HOLIDAYS.map((h) => {
        const next = upcoming.find((u) => u.key === h.key);
        return {
          key: h.key,
          name: h.name,
          next: next ? dayLabel(next.date, zone) : null,
          open: open.has(h.key),
        };
      }),
      consentPreview:
        business.config === null
          ? null
          : tidy(
              new TemplateRenderer().render(template.consent.message, {
                business: buildBusinessContext(business.config, prepared.config.schema, zone),
                agent: agentSettings(template),
                now: buildNowContext(local),
                contact: buildContactContext({ name: null, fields: {}, upcomingBookings: [] }, []),
              }),
            ),
    };
  });
}

/** Saves the config if it validates against the pinned template; field errors otherwise. */
export async function saveConfig(
  deps: ServiceDeps,
  actor: Actor,
  config: unknown,
): Promise<{ ok: true } | { ok: false; errors: FieldError[] }> {
  return inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const prepared = await pinnedTemplate(scope);
    const result = validateBusinessConfig(prepared, config);
    if (!result.ok) {
      return {
        ok: false,
        errors: result.issues.map((i) => ({ path: [...i.path], message: i.message })),
      };
    }
    const before = scope.business.config ?? {};
    await updateBusinessConfig(scope.tx, scope.business.id, config);
    const changed = Object.keys({ ...before, ...result.value }).filter(
      (key) => stableJson(before[key]) !== stableJson(result.value[key]),
    );
    await scope.audit("config.update", { changed });
    return { ok: true };
  });
}

export async function addResource(
  deps: ServiceDeps,
  actor: Actor,
  input: { name: string; capacity?: number | null },
): Promise<void> {
  await inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const { template } = await pinnedTemplate(scope);
    if (!template.booking) {
      throw new ActionRefusedError("no_booking", "Este negocio no agenda citas.");
    }
    const name = input.name.trim();
    if (name === "") throw new ActionRefusedError("name_required", "Escriba un nombre.");
    const resource = await createResource(scope.tx, {
      businessId: scope.business.id,
      kind: String(template.booking.resource_kind),
      name,
      capacity: input.capacity ?? null,
    });
    await scope.audit("resource.create", { resource_id: resource.id, name });
  });
}

export async function editResource(
  deps: ServiceDeps,
  actor: Actor,
  resourceId: string,
  changes: { name?: string; capacity?: number | null; active?: boolean },
): Promise<void> {
  requireIds("resource", resourceId);
  await inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const name = changes.name?.trim();
    if (name === "") throw new ActionRefusedError("name_required", "Escriba un nombre.");
    const updated = await updateResource(scope.tx, resourceId, {
      ...changes,
      ...(name === undefined ? {} : { name }),
    });
    if (!updated) throw new NotFoundError("resource");
    await scope.audit("resource.update", { resource_id: resourceId, ...changes });
  });
}

/** Blocks time (spec §12 "block time"): vacations, a chair in repair. Staff can too. */
export async function addClosure(
  deps: ServiceDeps,
  actor: Actor,
  input: { resourceId: string | null; from: string; to: string; reason: string | null },
): Promise<void> {
  requireIds("resource", input.resourceId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const zone = scope.business.timezone;
    const startsAt = parseLocal(input.from, zone);
    const endsAt = parseLocal(input.to, zone);
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      throw new ActionRefusedError(
        "bad_range",
        "La hora de fin debe ser posterior a la de inicio.",
      );
    }
    if (input.resourceId) {
      const resources = await listResources(scope.tx, scope.business.id);
      if (!resources.some((r) => r.id === input.resourceId)) throw new NotFoundError("resource");
    }
    const closure = await createClosure(scope.tx, {
      businessId: scope.business.id,
      resourceId: input.resourceId,
      startsAt,
      endsAt,
      reason: input.reason?.trim() || null,
    });
    await scope.audit("closure.create", {
      closure_id: closure.id,
      resource_id: input.resourceId,
      from: toLocalInput(startsAt, zone),
      to: toLocalInput(endsAt, zone),
    });
  });
}

export async function removeClosure(
  deps: ServiceDeps,
  actor: Actor,
  closureId: string,
): Promise<void> {
  requireIds("closure", closureId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    if (!(await deleteClosure(scope.tx, closureId))) throw new NotFoundError("closure");
    await scope.audit("closure.delete", { closure_id: closureId });
  });
}

/** Spec review C2: open on a public holiday every year (true), or closed (false, default). */
export async function setHoliday(
  deps: ServiceDeps,
  actor: Actor,
  holidayKey: string,
  open: boolean,
): Promise<void> {
  await inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    await setHolidayOpen(scope.tx, scope.business.id, holidayKey, open);
    await scope.audit("holiday.set", { holiday: holidayKey, open });
  });
}
