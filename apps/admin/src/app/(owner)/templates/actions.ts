"use server";

import {
  deprecateTemplate,
  publishTemplate,
  requestEvalRun,
  uploadTemplate,
} from "@platform/services";
import type { Issue } from "@platform/templates";
import { revalidatePath } from "next/cache";
import { attempt, failure, type ActionState } from "../../../lib/actions.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field } from "../../../lib/form-data.ts";

export type UploadState =
  | { ok: true; slug: string; version: string; warnings: Issue[] }
  | { ok: false; issues: Issue[]; message?: string }
  | null;

export async function uploadAction(_state: UploadState, form: FormData): Promise<UploadState> {
  const actor = await requireActor();
  const file = form.get("file");
  const pasted = field(form, "source");
  const source = file instanceof File && file.size > 0 ? await file.text() : pasted;
  if (source.trim() === "")
    return { ok: false, issues: [], message: "Choose a YAML file or paste one." };
  try {
    const result = await uploadTemplate(services(), actor, source);
    revalidatePath("/templates");
    return result;
  } catch (error) {
    return { ok: false, issues: [], message: failure(error, "en").message };
  }
}

/** Refused with the gate's reason until a live eval run of this upload passes (spec §10). */
export async function publishAction(
  slug: string,
  version: string,
  _state: ActionState,
): Promise<ActionState> {
  const actor = await requireActor();
  const result = await attempt(() => publishTemplate(services(), actor, slug, version), {
    lang: "en",
    ok: "Published.",
  });
  revalidatePath(`/templates/${slug}/${version}`);
  revalidatePath("/templates");
  return result;
}

/** Queues a live eval run (3 per scenario) for the worker (spec §11). */
export async function runEvalsAction(
  slug: string,
  version: string,
  _state: ActionState,
): Promise<ActionState> {
  const actor = await requireActor();
  const result = await attempt(
    () => requestEvalRun(services(), actor, slug, version).then(() => undefined),
    {
      lang: "en",
      ok: "Queued. The worker runs it next; this page updates as it goes.",
    },
  );
  revalidatePath(`/templates/${slug}/${version}`);
  return result;
}

export async function deprecateAction(slug: string, version: string): Promise<void> {
  const actor = await requireActor();
  await deprecateTemplate(services(), actor, slug, version);
  revalidatePath(`/templates/${slug}/${version}`);
  revalidatePath("/templates");
}
