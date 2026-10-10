import {
  InvalidInputError,
  activateBusiness,
  businesses,
  channels,
  createBusiness,
  createChannel,
  createUser,
  deleteUserSessions,
  disableChannel,
  getActiveChannel,
  getBusiness,
  getTemplateVersion,
  getUserByEmail,
  listAudit,
  listBusinessUsers,
  listResources,
  listTemplateVersions,
  listWaTemplates,
  preparedTemplateFor,
  recordAudit,
  removeMembership,
  setBusinessPaused,
  setMembership,
  setUserPassword,
  updateBusinessSettings,
  upgradeBusinessTemplate,
  type BusinessLimits,
  type BusinessUser,
  type MembershipRole,
} from "@platform/db";
import { compareSemver, validateBusinessConfig, type JsonSchema } from "@platform/templates";
import { asc, eq } from "drizzle-orm";
import { requireOwner, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import type { DiffLine } from "../diff.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";
import { uiSchemaFor, type UiSchema } from "../forms.ts";
import { hashPassword, passwordProblem } from "../password.ts";
import { authoredConfigSchema } from "../tenancy.ts";
import type { FieldError } from "../business/setup.ts";
import { templateDiff } from "./templates.ts";

/**
 * /businesses (spec §12, platform owner): create from a published template, connect the
 * WhatsApp channel (manual entry for v1), the activation checklist, users, caps and plan
 * price, pause, and the upgrade flow. Platform-level: runs as the owner role.
 */

export interface BusinessListItem {
  id: string;
  name: string;
  status: string;
  template: string;
  displayPhone: string | null;
  createdAt: Date;
}

export async function listBusinesses(deps: ServiceDeps, actor: Actor): Promise<BusinessListItem[]> {
  requireOwner(actor);
  const rows = await deps.db
    .select({ business: businesses, channel: channels })
    .from(businesses)
    .leftJoin(channels, eq(channels.businessId, businesses.id))
    .orderBy(asc(businesses.name));
  const out = new Map<string, BusinessListItem>();
  for (const { business, channel } of rows) {
    const existing = out.get(business.id);
    if (existing && (channel?.status !== "active" || existing.displayPhone)) continue;
    out.set(business.id, {
      id: business.id,
      name: business.name,
      status: business.status,
      template: `${business.templateSlug}@${business.templateVersion}`,
      displayPhone: channel?.status === "active" ? channel.displayPhone : null,
      createdAt: business.createdAt,
    });
  }
  return [...out.values()];
}

export async function createBusinessFromTemplate(
  deps: ServiceDeps,
  actor: Actor,
  input: {
    name: string;
    templateSlug: string;
    templateVersion: string;
    timezone?: string;
    limits?: BusinessLimits;
  },
): Promise<{ businessId: string }> {
  requireOwner(actor);
  const business = await createBusiness(deps.db, input);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: business.id,
    action: "business.create",
    payload: { name: business.name, template: `${input.templateSlug}@${input.templateVersion}` },
  });
  return { businessId: business.id };
}

/** Published versions of each template, newest first: what a business can be created on. */
export async function publishedTemplates(
  deps: ServiceDeps,
  actor: Actor,
): Promise<{ slug: string; name: string; version: string }[]> {
  requireOwner(actor);
  const rows = await deps.db.query.verticalTemplates.findMany();
  return rows
    .filter((r) => r.status === "published")
    .sort((a, b) => a.slug.localeCompare(b.slug) || compareSemver(b.version, a.version))
    .map((r) => ({ slug: r.slug, name: r.manifest.manifest.name, version: r.version }));
}

export interface ChecklistItem {
  key: "config" | "resources" | "channel" | "users" | "templates";
  label: string;
  done: boolean;
  /** Required before activation; the others are advice. */
  required: boolean;
}

export interface BusinessDetail {
  business: {
    id: string;
    name: string;
    status: string;
    templateSlug: string;
    templateVersion: string;
    timezone: string;
    limits: BusinessLimits;
    planPriceUsd: number | null;
    createdAt: Date;
  };
  channel: { phoneNumberId: string; wabaId: string; displayPhone: string } | null;
  checklist: ChecklistItem[];
  waTemplates: {
    name: string;
    language: string;
    status: string | null;
    category: string | null;
    rejectedReason: string | null;
  }[];
  users: BusinessUser[];
  /** Published versions newer than the pinned one. */
  upgrades: string[];
  audit: { action: string; actor: string | null; at: Date; payload: Record<string, unknown> }[];
}

export async function businessDetail(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
): Promise<BusinessDetail> {
  requireIds("business", businessId);
  requireOwner(actor);
  const business = await getBusiness(deps.db, businessId);
  if (!business) throw new NotFoundError("business");
  const channel = await getActiveChannel(deps.db, business.id);
  const versions = await listTemplateVersions(deps.db, business.templateSlug);
  const waTemplates = await listWaTemplates(deps.db, business.id);
  const users = await listBusinessUsers(deps.db, business.id);
  const audit = await listAudit(deps.db, { businessId: business.id, limit: 20 });
  return {
    business: {
      id: business.id,
      name: business.name,
      status: business.status,
      templateSlug: business.templateSlug,
      templateVersion: business.templateVersion,
      timezone: business.timezone,
      limits: business.limits,
      planPriceUsd: business.planPriceUsd === null ? null : Number(business.planPriceUsd),
      createdAt: business.createdAt,
    },
    channel: channel
      ? {
          phoneNumberId: channel.phoneNumberId,
          wabaId: channel.wabaId,
          displayPhone: channel.displayPhone,
        }
      : null,
    checklist: await checklist(deps, business.id),
    waTemplates: waTemplates.map((t) => ({
      name: t.metaName,
      language: t.language,
      status: t.metaStatus,
      category: t.categoryMeta ?? t.categoryRequested,
      rejectedReason: t.rejectedReason,
    })),
    users,
    upgrades: versions
      .filter(
        (v) => v.status === "published" && compareSemver(v.version, business.templateVersion) > 0,
      )
      .map((v) => v.version)
      .sort((a, b) => compareSemver(b, a)),
    audit: audit.map((a) => ({
      action: a.action,
      actor: a.actorEmail,
      at: a.at,
      payload: a.payload,
    })),
  };
}

/** What a business needs before it goes live (spec §12 activation checklist). */
export async function checklist(deps: ServiceDeps, businessId: string): Promise<ChecklistItem[]> {
  requireIds("business", businessId);
  const business = await getBusiness(deps.db, businessId);
  if (!business) throw new NotFoundError("business");
  const row = await getTemplateVersion(deps.db, business.templateSlug, business.templateVersion);
  if (!row) throw new NotFoundError("template");
  const booking = row.manifest.booking;
  const resources = (await listResources(deps.db, business.id)).filter(
    (r) => r.active && r.kind === String(booking?.resource_kind),
  );
  const users = await listBusinessUsers(deps.db, business.id);
  const templates = await listWaTemplates(deps.db, business.id);
  return [
    {
      key: "config",
      label: "Business data filled in (setup form)",
      done: business.config !== null,
      required: true,
    },
    ...(booking
      ? [
          {
            key: "resources" as const,
            label: `At least one ${String(booking.resource_label)} (resources)`,
            done: resources.length > 0,
            required: true,
          },
        ]
      : []),
    {
      key: "channel",
      label: "WhatsApp number connected",
      done: (await getActiveChannel(deps.db, business.id)) !== null,
      required: true,
    },
    {
      key: "users",
      label: "A business admin user can log in",
      done: users.some((u) => u.role === "business_admin" && u.active),
      required: false,
    },
    {
      key: "templates",
      label: "WhatsApp templates approved by Meta (reminders and other automatic messages)",
      done: templates.length > 0 && templates.every((t) => t.metaStatus === "APPROVED"),
      required: false,
    },
  ];
}

export async function activate(deps: ServiceDeps, actor: Actor, businessId: string): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  const missing = (await checklist(deps, businessId)).filter((c) => c.required && !c.done);
  if (missing.length > 0) {
    throw new ActionRefusedError(
      "checklist",
      `Not ready: ${missing.map((m) => m.label.toLowerCase()).join("; ")}.`,
    );
  }
  await activateBusiness(deps.db, businessId);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "business.activate",
  });
}

export async function setPaused(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  paused: boolean,
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  await setBusinessPaused(deps.db, businessId, paused);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: paused ? "business.pause" : "business.resume",
  });
}

/** v1: the platform owner types in Meta's ids and the access token (spec §12). */
export async function connectChannel(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  input: { phoneNumberId: string; wabaId: string; displayPhone: string; accessToken: string },
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  const business = await getBusiness(deps.db, businessId);
  if (!business) throw new NotFoundError("business");
  await deps.db.transaction(async (tx) => {
    const current = await getActiveChannel(tx, business.id);
    if (current) await disableChannel(tx, current.id);
    await createChannel(tx, deps.secrets, { businessId: business.id, ...input });
  });
  // The token never goes into the audit log.
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "business.channel",
    payload: { phone_number_id: input.phoneNumberId, waba_id: input.wabaId },
  });
}

export async function updateSettings(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  input: { name?: string; limits?: BusinessLimits; planPriceUsd?: number | null },
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  await updateBusinessSettings(deps.db, businessId, input);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "business.settings",
    payload: { ...input },
  });
}

/**
 * Gives someone access to the business: a new user with a temporary password, or an
 * existing user (same email) who gets this business too.
 */
export async function addBusinessUser(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  input: { email: string; name: string; role: MembershipRole; password: string },
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  if (!(await getBusiness(deps.db, businessId))) throw new NotFoundError("business");
  let user = await getUserByEmail(deps.db, input.email);
  if (!user) {
    const problem = passwordProblem(input.password);
    if (problem) throw new InvalidInputError("user", [{ path: "password", message: problem }]);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())) {
      throw new InvalidInputError("user", [{ path: "email", message: "is not an email address" }]);
    }
    user = await createUser(deps.db, {
      email: input.email,
      name: input.name.trim() || input.email,
      passwordHash: await hashPassword(input.password),
    });
    await recordAudit(deps.db, {
      actorUserId: actor.userId,
      businessId,
      action: "user.create",
      payload: { user_id: user.id, email: user.email },
    });
  }
  await setMembership(deps.db, { userId: user.id, businessId, role: input.role });
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "user.membership",
    payload: { user_id: user.id, role: input.role },
  });
}

export async function removeBusinessUser(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  userId: string,
): Promise<void> {
  requireIds("business", businessId, userId);
  requireOwner(actor);
  await removeMembership(deps.db, userId, businessId);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "user.remove",
    payload: { user_id: userId },
  });
}

/** A new temporary password for one of the business's users. */
export async function resetUserPassword(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  userId: string,
  password: string,
): Promise<void> {
  requireIds("business", businessId, userId);
  requireOwner(actor);
  const member = (await listBusinessUsers(deps.db, businessId)).find((u) => u.userId === userId);
  if (!member) throw new NotFoundError("user");
  const problem = passwordProblem(password);
  if (problem) throw new InvalidInputError("user", [{ path: "password", message: problem }]);
  await setUserPassword(deps.db, userId, await hashPassword(password));
  await deleteUserSessions(deps.db, userId);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "user.password_reset",
    payload: { user_id: userId },
  });
}

export interface UpgradePreview {
  from: string;
  to: string;
  diff: { section: string; lines: DiffLine[] }[];
  /** Config problems under the new version: the fields that need input. */
  configErrors: FieldError[];
  form: { schema: JsonSchema; uiSchema: UiSchema; config: Record<string, unknown> };
}

export async function upgradePreview(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  version: string,
): Promise<UpgradePreview> {
  requireIds("business", businessId);
  requireOwner(actor);
  const business = await getBusiness(deps.db, businessId);
  if (!business) throw new NotFoundError("business");
  const current = await getTemplateVersion(
    deps.db,
    business.templateSlug,
    business.templateVersion,
  );
  const target = await getTemplateVersion(deps.db, business.templateSlug, version);
  if (!current || target?.status !== "published") throw new NotFoundError("template version");
  const prepared = preparedTemplateFor(target);
  const result =
    business.config === null ? null : validateBusinessConfig(prepared, business.config);
  return {
    from: business.templateVersion,
    to: version,
    diff: templateDiff(current, target),
    configErrors:
      result && !result.ok
        ? result.issues.map((i) => ({ path: [...i.path], message: i.message }))
        : [],
    form: {
      schema: prepared.config.schema,
      uiSchema: uiSchemaFor(prepared.config.schema, authoredConfigSchema(target)),
      config: business.config ?? {},
    },
  };
}

/** Pins the newer version; `config` supplies fields the new version needs. */
export async function upgrade(
  deps: ServiceDeps,
  actor: Actor,
  businessId: string,
  version: string,
  config?: unknown,
): Promise<void> {
  requireIds("business", businessId);
  requireOwner(actor);
  const before = await getBusiness(deps.db, businessId);
  if (!before) throw new NotFoundError("business");
  await upgradeBusinessTemplate(deps.db, businessId, version, config);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId,
    action: "business.upgrade",
    payload: { from: before.templateVersion, to: version, config_changed: config !== undefined },
  });
}
