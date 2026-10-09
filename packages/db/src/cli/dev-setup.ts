/**
 * Local setup for trying the platform on Meta's test number (spec §15, M2 acceptance):
 * publishes templates/odontologia, creates a demo business, connects the test number.
 * Development only. The access token comes from the environment, never from arguments,
 * so it doesn't end up in shell history. Re-running is safe.
 */
import { readFile } from "node:fs/promises";
import {
  baseEnv,
  createLogger,
  createSecretBox,
  databaseEnv,
  encryptionEnv,
  parseEnv,
} from "@platform/shared";
import { validateTemplateSource } from "@platform/templates";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../client.ts";
import {
  createChannel,
  disableChannel,
  findActiveChannelByPhoneNumberId,
  getActiveChannel,
  updateChannelToken,
} from "../repositories/channels.ts";
import { activateBusiness, createBusiness } from "../repositories/businesses.ts";
import { createResource, listActiveResources } from "../repositories/scheduling.ts";
import {
  getTemplateVersion,
  saveTemplateDraft,
  setTemplateStatus,
} from "../repositories/templates.ts";
import { businesses } from "../schema/index.ts";

const env = parseEnv(
  baseEnv
    .extend(databaseEnv.shape)
    .extend(encryptionEnv.shape)
    .extend({
      WA_TEST_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
      WA_TEST_WABA_ID: z.string().regex(/^\d+$/),
      WA_TEST_DISPLAY_PHONE: z.string().min(1),
      WA_TEST_ACCESS_TOKEN: z.string().min(20),
    }),
);
if (env.NODE_ENV === "production") throw new Error("dev-setup is for local development only");

const logger = createLogger({ level: env.LOG_LEVEL, name: "dev-setup" });
const { db, close } = createDb(env.DATABASE_URL);
const BUSINESS_NAME = "Clínica Dental Demo";

try {
  const source = await readFile(
    new URL("../../../../templates/odontologia/template.yaml", import.meta.url),
    "utf8",
  );
  const template = validateTemplateSource(source).template;
  if (!template)
    throw new Error("templates/odontologia does not validate; run pnpm template validate");
  const { slug, version } = template.manifest;

  const existing = await getTemplateVersion(db, slug, version);
  if (existing?.status !== "published") {
    await saveTemplateDraft(db, { sourceYaml: source });
    await setTemplateStatus(db, slug, version, "published");
    logger.info(
      { template: `${slug}@${version}` },
      "template published (dev; the eval gate arrives in M6)",
    );
  }

  const [found] = await db.select().from(businesses).where(eq(businesses.name, BUSINESS_NAME));
  const business =
    found ??
    (await createBusiness(db, {
      name: BUSINESS_NAME,
      templateSlug: slug,
      templateVersion: version,
      config: template.sample_config,
    }));

  // Active, so automations run (spec §9). Activation records the Meta templates the
  // business needs; nothing reaches Meta unless META_TEMPLATE_SUBMISSION=on.
  if (business.status === "setup") {
    await activateBusiness(db, business.id);
    logger.info({ business_id: business.id }, "demo business activated");
  }

  // Demo resources (chairs for odontologia), taken from the template's eval fixtures.
  for (const resource of template.eval_fixtures?.resources ?? []) {
    const existing = await listActiveResources(db, business.id, resource.kind);
    if (!existing.some((r) => r.name === resource.name)) {
      await createResource(db, {
        businessId: business.id,
        kind: resource.kind,
        name: resource.name,
        capacity: resource.capacity ?? null,
      });
      logger.info({ kind: resource.kind, name: resource.name }, "resource created");
    }
  }

  const secrets = createSecretBox(env.ENCRYPTION_KEY);
  const channel = await findActiveChannelByPhoneNumberId(db, env.WA_TEST_PHONE_NUMBER_ID);
  if (channel) {
    // Test-number tokens expire after 24 hours: re-running setup refreshes it.
    await updateChannelToken(db, secrets, channel, env.WA_TEST_ACCESS_TOKEN);
    logger.info(
      { phone_number_id: channel.phoneNumberId },
      "channel already connected; token updated",
    );
  } else {
    const previous = await getActiveChannel(db, business.id);
    if (previous) {
      await disableChannel(db, previous.id);
      logger.info({ phone_number_id: previous.phoneNumberId }, "previous demo channel disabled");
    }
    await createChannel(db, secrets, {
      businessId: business.id,
      phoneNumberId: env.WA_TEST_PHONE_NUMBER_ID,
      wabaId: env.WA_TEST_WABA_ID,
      displayPhone: env.WA_TEST_DISPLAY_PHONE,
      accessToken: env.WA_TEST_ACCESS_TOKEN,
    });
    logger.info({ phone_number_id: env.WA_TEST_PHONE_NUMBER_ID }, "channel connected");
  }
  logger.info({ business_id: business.id, name: business.name }, "dev setup ready");
} finally {
  await close();
}
