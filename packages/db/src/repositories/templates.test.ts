import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TemplateInvalidError, TemplateVersionLockedError } from "../errors.ts";
import { createTestDatabase, type TestDatabase } from "../testing.ts";
import { ODONTOLOGIA_SOURCE } from "./fixtures.ts";
import { listTemplateVersions, saveTemplateDraft, setTemplateStatus } from "./templates.ts";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

const withVersion = (version: string, source = ODONTOLOGIA_SOURCE) =>
  source.replace(/^ {2}version: 1\.0\.0$/m, `  version: ${version}`);

describe("template uploads", () => {
  it("stores a valid upload as a draft with the parsed template", async () => {
    const { row, warnings } = await saveTemplateDraft(testDb.db, {
      sourceYaml: ODONTOLOGIA_SOURCE,
    });
    expect(warnings).toEqual([]);
    expect(row).toMatchObject({
      slug: "odontologia",
      version: "1.0.0",
      status: "draft",
      publishedAt: null,
    });
    expect(row.manifest.agent.tools).toHaveProperty("book");
    expect(row.sourceYaml).toBe(ODONTOLOGIA_SOURCE);
  });

  it("replaces a draft when the same version is uploaded again", async () => {
    const edited = ODONTOLOGIA_SOURCE.replace("max_reply_words: 60", "max_reply_words: 50");
    const { row } = await saveTemplateDraft(testDb.db, { sourceYaml: edited });
    expect(row.manifest.agent.max_reply_words).toBe(50);
    expect(await listTemplateVersions(testDb.db, "odontologia")).toHaveLength(1);
  });

  it("refuses an invalid upload, listing issues with paths", async () => {
    const broken = ODONTOLOGIA_SOURCE.replace("template: solicitud_resena", "template: resena");
    const error = await saveTemplateDraft(testDb.db, { sourceYaml: broken }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TemplateInvalidError);
    expect((error as TemplateInvalidError).issues).toContainEqual(
      expect.objectContaining({ path: "automations[3].action.template", severity: "error" }),
    );
  });

  it("locks a version once published", async () => {
    await setTemplateStatus(testDb.db, "odontologia", "1.0.0", "published");
    await expect(
      saveTemplateDraft(testDb.db, { sourceYaml: ODONTOLOGIA_SOURCE }),
    ).rejects.toBeInstanceOf(TemplateVersionLockedError);
  });

  it("checks upgrade rules against the latest published version", async () => {
    const minorWithNewCategory = withVersion("1.1.0").replace(
      "  - key: recordatorio_cita\n    category: UTILITY",
      "  - key: recordatorio_cita\n    category: MARKETING",
    );
    const error = await saveTemplateDraft(testDb.db, { sourceYaml: minorWithNewCategory }).catch(
      (e: unknown) => e,
    );
    expect((error as TemplateInvalidError).issues).toContainEqual(
      expect.objectContaining({
        path: "wa_templates[0].category",
        message: expect.stringMatching(/bump the major/),
      }),
    );
    const { row } = await saveTemplateDraft(testDb.db, { sourceYaml: withVersion("1.1.0") });
    expect(row.status).toBe("draft");
  });

  it("only allows draft → published → deprecated", async () => {
    await expect(
      setTemplateStatus(testDb.db, "odontologia", "1.1.0", "deprecated"),
    ).rejects.toThrow(/is not published/);
    await expect(
      setTemplateStatus(testDb.db, "odontologia", "1.0.0", "deprecated"),
    ).resolves.toMatchObject({
      status: "deprecated",
    });
  });
});
