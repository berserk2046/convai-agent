import { readFileSync } from "node:fs";
import { validateTemplateSource } from "@platform/templates";
import type { Executor } from "../tenant.ts";
import { createBusiness } from "./businesses.ts";
import { getTemplateVersion, saveTemplateDraft, setTemplateStatus } from "./templates.ts";

/** templates/odontologia/template.yaml (Appendix A), for tests. */
export const ODONTOLOGIA_SOURCE = readFileSync(
  new URL("../../../../templates/odontologia/template.yaml", import.meta.url),
  "utf8",
);

export async function publishOdontologia(db: Executor, source = ODONTOLOGIA_SOURCE) {
  const { row } = await saveTemplateDraft(db, { sourceYaml: source });
  return setTemplateStatus(db, row.slug, row.version, "published");
}

/** Appendix A's sample_config, as written (no defaults applied). */
export const ODONTOLOGIA_SAMPLE_CONFIG: Record<string, unknown> = (() => {
  const template = validateTemplateSource(ODONTOLOGIA_SOURCE).template;
  if (!template) throw new Error("templates/odontologia must validate");
  return template.sample_config;
})();

/** A business on odontologia@1.0.0 (publishing the template first if needed). */
export async function createTestBusiness(db: Executor, name = "Clínica Demo") {
  const existing = await getTemplateVersion(db, "odontologia", "1.0.0");
  if (existing?.status !== "published") await publishOdontologia(db);
  return createBusiness(db, {
    name,
    templateSlug: "odontologia",
    templateVersion: "1.0.0",
    config: ODONTOLOGIA_SAMPLE_CONFIG,
  });
}
