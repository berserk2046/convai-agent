import {
  TEMPLATE_EXISTS_SUBCODE,
  WhatsAppSendError,
  type MetaTemplate,
  type TemplateApi,
} from "@platform/channels";
import {
  applyWaTemplateUpdate,
  channelAccessToken,
  getActiveChannel,
  listActiveBusinesses,
  listWaTemplates,
  recordWaTemplateSubmission,
  withTenant,
  type BusinessRow,
  type Database,
  type WaMessageTemplateRow,
} from "@platform/db";
import { alert, type Logger, type SecretBox } from "@platform/shared";

/**
 * Meta message templates (spec §9, decision A16), reconciled every few minutes for each
 * active business:
 * - Submission (behind META_TEMPLATE_SUBMISSION, off until the owner approves): templates
 *   Meta doesn't have yet are created; a body changed in a minor version is edited.
 * - Status sync: Meta's status and category for every template it knows. Webhooks do this
 *   too; the sync catches missed ones. It only reads.
 * Activation and upgrades only record what should be at Meta (`activateBusiness`).
 */

export interface TemplateSyncDeps {
  db: Database;
  logger: Logger;
  secrets: SecretBox;
  templates: TemplateApi;
  now: () => Date;
  /** META_TEMPLATE_SUBMISSION=on: create and edit templates at Meta. */
  submissionEnabled: boolean;
}

export const TEMPLATE_SYNC_EVERY_MS = 15 * 60_000;

/** Meta only allows editing templates in these states (template management docs). */
const EDITABLE = new Set(["APPROVED", "REJECTED", "PAUSED"]);

export async function reconcileWaTemplates(
  deps: TemplateSyncDeps,
): Promise<{ created: number; edited: number; updated: number }> {
  const totals = { created: 0, edited: 0, updated: 0 };
  for (const business of await listActiveBusinesses(deps.db)) {
    try {
      const result = await reconcileBusiness(deps, business);
      totals.created += result.created;
      totals.edited += result.edited;
      totals.updated += result.updated;
    } catch (error) {
      alert(
        deps.logger,
        "wa_template_sync_failed",
        {
          business_id: business.id,
          err: error instanceof WhatsAppSendError ? error.toJSON() : error,
        },
        "could not reconcile WhatsApp templates",
      );
    }
  }
  return totals;
}

async function reconcileBusiness(deps: TemplateSyncDeps, business: BusinessRow) {
  const result = { created: 0, edited: 0, updated: 0 };
  const { channel, rows } = await withTenant(deps.db, business.id, async (tx) => ({
    channel: await getActiveChannel(tx, business.id),
    rows: await listWaTemplates(tx, business.id),
  }));
  if (!channel || rows.length === 0) return result;
  const auth = { wabaId: channel.wabaId, accessToken: channelAccessToken(channel, deps.secrets) };
  const log = deps.logger.child({ business_id: business.id, waba_id: channel.wabaId });
  let remote: MetaTemplate[] | null = null;
  const listRemote = async () => (remote ??= await deps.templates.list(auth));

  if (deps.submissionEnabled) {
    for (const row of rows) {
      if (row.metaTemplateId === null) {
        if (await create(deps, business, row, auth, listRemote)) result.created += 1;
      } else if (
        !sameComponents(row.components, row.submittedComponents) &&
        EDITABLE.has(row.metaStatus ?? "")
      ) {
        await deps.templates.edit(auth.accessToken, row.metaTemplateId, row.components);
        await withTenant(deps.db, business.id, (tx) =>
          recordWaTemplateSubmission(tx, row.id, {
            metaTemplateId: row.metaTemplateId ?? "",
            status: null,
            category: null,
            submittedComponents: row.components,
            at: deps.now(),
          }),
        );
        log.info({ template: row.metaName }, "template edited at Meta");
        result.edited += 1;
      }
    }
  }

  if (rows.some((r) => r.metaTemplateId !== null) || result.created > 0) {
    remote = null; // re-read after creating
    for (const template of await listRemote()) {
      const row = rows.find((r) => sameTemplate(r, template));
      if (
        !row ||
        (row.metaStatus === template.status &&
          row.categoryMeta === template.category &&
          row.metaTemplateId === template.id)
      )
        continue;
      const updated = await withTenant(deps.db, business.id, (tx) =>
        applyWaTemplateUpdate(
          tx,
          business.id,
          {
            name: template.name,
            language: template.language,
            metaTemplateId: template.id,
            replaceId: true,
          },
          {
            ...(template.status ? { status: template.status } : {}),
            ...(template.category ? { category: template.category } : {}),
            at: deps.now(),
          },
        ),
      );
      result.updated += updated.length;
    }
  }
  return result;
}

/**
 * Creates one template. If Meta already has that name and language (an earlier attempt,
 * or another business on the same account), it is adopted, but only when its body is ours.
 */
async function create(
  deps: TemplateSyncDeps,
  business: BusinessRow,
  row: WaMessageTemplateRow,
  auth: { wabaId: string; accessToken: string },
  listRemote: () => Promise<MetaTemplate[]>,
): Promise<boolean> {
  const log = deps.logger.child({ business_id: business.id, template: row.metaName });
  let created: { id: string; status: string | null; category: string | null };
  try {
    created = await deps.templates.create(auth, {
      name: row.metaName,
      language: row.language,
      category: row.categoryRequested,
      components: row.components,
    });
  } catch (error) {
    if (!(error instanceof WhatsAppSendError) || error.subcode !== TEMPLATE_EXISTS_SUBCODE)
      throw error;
    const existing = (await listRemote()).find((t) => sameTemplate(row, t));
    if (!existing || bodyText(existing.components) !== bodyText(row.components)) {
      alert(
        log,
        "wa_template_name_taken",
        { language: row.language },
        "Meta already has a different template with this name; not adopting it",
      );
      return false;
    }
    created = { id: existing.id, status: existing.status, category: existing.category };
  }
  await withTenant(deps.db, business.id, (tx) =>
    recordWaTemplateSubmission(tx, row.id, {
      metaTemplateId: created.id,
      status: created.status,
      category: created.category,
      submittedComponents: row.components,
      at: deps.now(),
    }),
  );
  log.info({ meta_status: created.status }, "template submitted to Meta");
  return true;
}

function sameTemplate(row: WaMessageTemplateRow, template: MetaTemplate): boolean {
  return (
    row.metaName === template.name && row.language.toLowerCase() === template.language.toLowerCase()
  );
}

function sameComponents(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function bodyText(components: readonly Record<string, unknown>[]): string | null {
  const body = components.find((c) => String(c.type).toUpperCase() === "BODY");
  return typeof body?.text === "string" ? body.text : null;
}
