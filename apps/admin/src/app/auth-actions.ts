"use server";

import {
  SESSION_COOKIE,
  changePassword,
  impersonate,
  login,
  logout,
  stopImpersonating,
  switchBusiness,
} from "@platform/services";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "../lib/actions.ts";
import { secureCookies, services } from "../lib/server.ts";
import { clientIp, requireActor } from "../lib/session.ts";
import { field } from "../lib/form-data.ts";

/** Logins, logouts and switching the session's business. Each checks the session itself. */

export async function loginAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const store = await cookies();
  const result = await login(services(), {
    email: field(form, "email"),
    password: field(form, "password"),
    ip: await clientIp(),
    previousToken: store.get(SESSION_COOKIE)?.value ?? null,
  });
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "rate_limited"
          ? "Demasiados intentos. Espere 15 minutos e intente de nuevo."
          : "Correo o contraseña incorrectos.",
    };
  }
  store.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await logout(services(), token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function switchBusinessAction(form: FormData): Promise<void> {
  const actor = await requireActor();
  await switchBusiness(services(), actor, field(form, "businessId"));
  redirect("/");
}

export async function impersonateAction(businessId: string): Promise<void> {
  const actor = await requireActor();
  await impersonate(services(), actor, businessId);
  redirect("/setup");
}

export async function stopImpersonatingAction(): Promise<void> {
  const actor = await requireActor();
  const businessId = actor.business?.id;
  await stopImpersonating(services(), actor);
  redirect(businessId ? `/businesses/${businessId}` : "/businesses");
}

export async function changePasswordAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const next = field(form, "next");
  if (next !== field(form, "confirm")) {
    return { ok: false, message: "Las contraseñas nuevas no coinciden." };
  }
  return attempt(
    () => changePassword(services(), actor, { current: field(form, "current"), next }),
    { ok: "Contraseña actualizada." },
  );
}
