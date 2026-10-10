"use server";

import {
  activate,
  addBusinessUser,
  connectChannel,
  createBusinessFromTemplate,
  removeBusinessUser,
  resetUserPassword,
  setPaused,
  updateSettings,
  upgrade,
} from "@platform/services";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, failure, type ActionState } from "../../../lib/actions.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field } from "../../../lib/form-data.ts";

/** Platform-owner actions; each service call checks the owner role itself. */

const text = (form: FormData, name: string) => field(form, name).trim();
const optionalNumber = (form: FormData, name: string) => {
  const value = text(form, name);
  return value === "" ? undefined : Number(value);
};

export async function createBusinessAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const [templateSlug = "", templateVersion = ""] = text(form, "template").split("@");
  const llm = optionalNumber(form, "llmUsdMonth");
  const marketing = optionalNumber(form, "marketingMsgsMonth");
  let businessId: string;
  try {
    ({ businessId } = await createBusinessFromTemplate(services(), actor, {
      name: text(form, "name"),
      templateSlug,
      templateVersion,
      timezone: text(form, "timezone") || "America/Bogota",
      limits: {
        ...(llm === undefined ? {} : { llm_usd_month: llm }),
        ...(marketing === undefined ? {} : { marketing_msgs_month: marketing }),
      },
    }));
  } catch (error) {
    return { ...failure(error, "en"), at: Date.now() };
  }
  redirect(`/businesses/${businessId}`);
}

export async function connectChannelAction(
  businessId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const state = await attempt(
    () =>
      connectChannel(services(), actor, businessId, {
        phoneNumberId: text(form, "phoneNumberId"),
        wabaId: text(form, "wabaId"),
        displayPhone: text(form, "displayPhone"),
        accessToken: text(form, "accessToken"),
      }),
    { ok: "Channel connected.", lang: "en" },
  );
  revalidatePath(`/businesses/${businessId}`);
  return state;
}

export async function addUserAction(
  businessId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const role = text(form, "role") === "business_staff" ? "business_staff" : "business_admin";
  const state = await attempt(
    () =>
      addBusinessUser(services(), actor, businessId, {
        email: text(form, "email"),
        name: text(form, "name"),
        role,
        password: field(form, "password"),
      }),
    { ok: "User added. Share the temporary password with them privately.", lang: "en" },
  );
  revalidatePath(`/businesses/${businessId}`);
  return state;
}

export async function resetPasswordAction(
  businessId: string,
  userId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  return attempt(
    () => resetUserPassword(services(), actor, businessId, userId, field(form, "password")),
    { ok: "Password changed.", lang: "en" },
  );
}

export async function removeUserAction(businessId: string, userId: string): Promise<void> {
  const actor = await requireActor();
  await removeBusinessUser(services(), actor, businessId, userId);
  revalidatePath(`/businesses/${businessId}`);
}

export async function settingsAction(
  businessId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const llm = optionalNumber(form, "llmUsdMonth");
  const marketing = optionalNumber(form, "marketingMsgsMonth");
  const plan = text(form, "planPriceUsd");
  const state = await attempt(
    () =>
      updateSettings(services(), actor, businessId, {
        name: text(form, "name"),
        limits: {
          ...(llm === undefined ? {} : { llm_usd_month: llm }),
          ...(marketing === undefined ? {} : { marketing_msgs_month: marketing }),
        },
        planPriceUsd: plan === "" ? null : Number(plan),
      }),
    { ok: "Saved.", lang: "en" },
  );
  revalidatePath(`/businesses/${businessId}`);
  return state;
}

export async function activateAction(
  businessId: string,
  _state: ActionState,
): Promise<ActionState> {
  const actor = await requireActor();
  const state = await attempt(() => activate(services(), actor, businessId), {
    ok: "Active.",
    lang: "en",
  });
  revalidatePath(`/businesses/${businessId}`);
  return state;
}

export async function pauseAction(businessId: string, paused: unknown): Promise<void> {
  const actor = await requireActor();
  await setPaused(services(), actor, businessId, paused === true);
  revalidatePath(`/businesses/${businessId}`);
}

/** Upgrade, with the config the new version needs (JSON from the generated form). */
export async function upgradeAction(
  businessId: string,
  version: string,
  config: unknown,
): Promise<{ ok: boolean; message: string | null; errors?: { path: string; message: string }[] }> {
  const actor = await requireActor();
  try {
    await upgrade(services(), actor, businessId, version, config);
  } catch (error) {
    const result = failure(error, "en");
    return {
      ok: false,
      message: result.message,
      errors: Object.entries(result.fields ?? {}).map(([path, message]) => ({ path, message })),
    };
  }
  revalidatePath(`/businesses/${businessId}`);
  redirect(`/businesses/${businessId}`);
}
