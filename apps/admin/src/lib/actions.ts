import { InvalidInputError, SlotTakenError } from "@platform/db";
import {
  ActionRefusedError,
  ForbiddenError,
  NotAuthenticatedError,
  NotFoundError,
} from "@platform/services";
import { issueText } from "./issue-text.ts";
import { services } from "./server.ts";

/**
 * What a server action tells its form (React's useActionState). Services throw typed
 * errors; this turns the expected ones into a message and logs the rest without exposing
 * details to the browser.
 */
export type ActionState = {
  ok: boolean;
  message: string | null;
  /** Field name → message, for forms that show errors next to inputs. */
  fields?: Record<string, string>;
  /** Changes on every result, so forms can reset after a success. */
  at?: number;
} | null;

type Lang = "es" | "en";

export async function attempt(
  work: () => Promise<void>,
  options: { ok?: string; lang?: Lang } = {},
): Promise<ActionState> {
  const lang = options.lang ?? "es";
  try {
    await work();
    return { ok: true, message: options.ok ?? null, at: Date.now() };
  } catch (error) {
    return { ...failure(error, lang), at: Date.now() };
  }
}

export function failure(
  error: unknown,
  lang: Lang = "es",
): { ok: false; message: string; fields?: Record<string, string> } {
  if (error instanceof ActionRefusedError) return { ok: false, message: error.message };
  if (error instanceof InvalidInputError) {
    const fields = Object.fromEntries(
      error.issues.map((i) => [i.path, lang === "es" ? issueText(i.message) : i.message]),
    );
    const first = error.issues[0];
    return {
      ok: false,
      message:
        lang === "es"
          ? "Revise los datos marcados."
          : first
            ? `${first.path || "input"} ${first.message}`
            : "Invalid input.",
      fields,
    };
  }
  if (error instanceof SlotTakenError) {
    return {
      ok: false,
      message: lang === "es" ? "Ese horario ya está ocupado." : "That slot is taken.",
    };
  }
  if (error instanceof NotFoundError) {
    return { ok: false, message: lang === "es" ? "No se encontró." : "Not found." };
  }
  if (error instanceof ForbiddenError || error instanceof NotAuthenticatedError) {
    return { ok: false, message: lang === "es" ? "No tiene permiso para esto." : "Not allowed." };
  }
  // Next's redirect() and notFound() work by throwing; let them through.
  if (isNextControlFlow(error)) throw error;
  services().logger.error({ err: error }, "admin action failed");
  return {
    ok: false,
    message:
      lang === "es" ? "Algo salió mal. Intente de nuevo." : "Something went wrong. Try again.",
  };
}

function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR)/.test(digest)
  );
}
