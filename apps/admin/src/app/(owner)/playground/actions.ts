"use server";

import {
  closePlayground,
  deletePlayground,
  playgroundReturnToBot,
  playgroundSay,
  startPlayground,
} from "@platform/services";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, failure, type ActionState } from "../../../lib/actions.ts";
import { field } from "../../../lib/form-data.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";

/** Starts a session in a fresh sandbox and opens it. */
export async function startAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const template = field(form, "template");
  const at = template.lastIndexOf("@");
  const config = field(form, "config");
  let sessionId: string;
  try {
    ({ sessionId } = await startPlayground(services(), actor, {
      slug: template.slice(0, at),
      version: template.slice(at + 1),
      businessId: config === "sample" || config === "" ? null : config,
      consentGiven: form.get("consent") === "on",
    }));
  } catch (error) {
    return { ...failure(error, "en"), at: Date.now() };
  }
  revalidatePath("/playground");
  redirect(`/playground/${sessionId}`);
}

export async function sayAction(
  sessionId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const result = await attempt(
    () => playgroundSay(services(), actor, sessionId, field(form, "message")),
    { lang: "en" },
  );
  revalidatePath(`/playground/${sessionId}`);
  return result;
}

export async function returnToBotAction(sessionId: string): Promise<void> {
  const actor = await requireActor();
  await playgroundReturnToBot(services(), actor, sessionId);
  revalidatePath(`/playground/${sessionId}`);
}

export async function closeAction(sessionId: string): Promise<void> {
  const actor = await requireActor();
  await closePlayground(services(), actor, sessionId);
  revalidatePath(`/playground/${sessionId}`);
  revalidatePath("/playground");
}

export async function deleteAction(sessionId: string): Promise<void> {
  const actor = await requireActor();
  await deletePlayground(services(), actor, sessionId);
  revalidatePath("/playground");
  redirect("/playground");
}
