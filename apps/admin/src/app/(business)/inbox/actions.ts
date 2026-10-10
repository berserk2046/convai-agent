"use server";

import {
  closeHandoff,
  markRead,
  recordConsent,
  reenableAutomaticMessages,
  replyToConversation,
  sendTemplateToConversation,
  takeOverConversation,
} from "@platform/services";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "../../../lib/actions.ts";
import { isUuid } from "../../../lib/ids.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field } from "../../../lib/form-data.ts";

/** /inbox actions: staff and admins. Services scope every id to the session's business. */

function refresh(conversationId: string) {
  revalidatePath("/inbox");
  revalidatePath(`/inbox/${conversationId}`);
}

export async function replyAction(
  conversationId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const state = await attempt(() =>
    replyToConversation(services(), actor, conversationId, {
      text: field(form, "text"),
      clientId: field(form, "clientId"),
    }),
  );
  refresh(conversationId);
  return state;
}

export async function sendTemplateAction(
  conversationId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const bookingId = field(form, "bookingId");
  const state = await attempt(
    () =>
      sendTemplateToConversation(services(), actor, conversationId, {
        templateKey: field(form, "templateKey"),
        bookingId: bookingId === "" ? null : bookingId,
        clientId: field(form, "clientId"),
      }),
    { ok: "Mensaje enviado." },
  );
  refresh(conversationId);
  return state;
}

export async function takeOverAction(conversationId: string): Promise<void> {
  const actor = await requireActor();
  await takeOverConversation(services(), actor, conversationId);
  refresh(conversationId);
}

export async function closeHandoffAction(conversationId: string): Promise<void> {
  const actor = await requireActor();
  await closeHandoff(services(), actor, conversationId);
  refresh(conversationId);
}

export async function consentAction(
  conversationId: string,
  contactId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const state = await attempt(
    () =>
      recordConsent(services(), actor, contactId, { confirmed: form.get("confirmed") === "on" }),
    { ok: "Autorización registrada." },
  );
  refresh(conversationId);
  return state;
}

export async function reenableAction(
  conversationId: string,
  contactId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (form.get("confirmed") !== "on") {
    return { ok: false, message: "Confirme que el cliente lo pidió.", at: Date.now() };
  }
  const state = await attempt(() => reenableAutomaticMessages(services(), actor, contactId), {
    ok: "Mensajes automáticos activados de nuevo.",
  });
  refresh(conversationId);
  return state;
}

/** Opening a notice marks it read and goes to its conversation. */
export async function openNotificationAction(
  id: string,
  conversationId: string | null,
): Promise<void> {
  const actor = await requireActor();
  await markRead(services(), actor, [id]);
  revalidatePath("/", "layout");
  redirect(conversationId && isUuid(conversationId) ? `/inbox/${conversationId}` : "/inbox");
}

export async function markAllReadAction(): Promise<void> {
  const actor = await requireActor();
  await markRead(services(), actor, null);
  revalidatePath("/", "layout");
}
