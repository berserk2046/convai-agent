/**
 * How a failed send should be handled:
 * - transient: Meta definitely didn't take the message (rate limit, 5xx, no connection);
 *   retrying is safe.
 * - permanent: this message will never go through as-is (bad recipient, window closed,
 *   template problem); don't retry.
 * - config: our setup is broken (token expired, permissions, payment, account
 *   restricted); don't retry, alert the platform owner.
 * - unknown: the request may have reached Meta (timeout, dropped connection); retrying
 *   could double-send, so we don't (spec review B15).
 */
export type SendErrorKind = "transient" | "permanent" | "config" | "unknown";

/** Codes from Meta's Cloud API error-code reference (checked 2026-10). */
const TRANSIENT_CODES = new Set([4, 80007, 130429, 131000, 131016, 131056]);
const CONFIG_CODES = new Set([0, 3, 10, 190, 368, 131005, 131031, 131037, 131042, 133010]);
/** Connection errors that happen before any byte reaches Meta. */
const NOT_SENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);

export class WhatsAppSendError extends Error {
  readonly kind: SendErrorKind;
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly details: string | null;
  readonly fbtraceId: string | null;

  constructor(
    message: string,
    fields: {
      kind: SendErrorKind;
      httpStatus?: number | null;
      code?: number | null;
      subcode?: number | null;
      details?: string | null;
      fbtraceId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "WhatsAppSendError";
    this.kind = fields.kind;
    this.httpStatus = fields.httpStatus ?? null;
    this.code = fields.code ?? null;
    this.subcode = fields.subcode ?? null;
    this.details = fields.details ?? null;
    this.fbtraceId = fields.fbtraceId ?? null;
  }

  /** Safe to store and log: no token, no message text. */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      message: this.message,
      httpStatus: this.httpStatus,
      code: this.code,
      subcode: this.subcode,
      details: this.details,
      fbtraceId: this.fbtraceId,
    };
  }
}

export function classifyApiError(httpStatus: number, code: number | null): SendErrorKind {
  if (code !== null && CONFIG_CODES.has(code)) return "config";
  if (code !== null && TRANSIENT_CODES.has(code)) return "transient";
  if (httpStatus === 429 || httpStatus >= 500) return "transient";
  if (httpStatus === 401 || httpStatus === 403) return "config";
  return "permanent";
}

export function classifyNetworkError(error: unknown): SendErrorKind {
  // fetch wraps the socket error in `cause`; dual-stack connects wrap several in `errors`.
  const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)
    ?.cause;
  const codes = [cause?.code, ...(cause?.errors ?? []).map((e) => e.code)];
  const notSent = codes.some(
    (code) => typeof code === "string" && NOT_SENT_NETWORK_CODES.has(code),
  );
  return notSent ? "transient" : "unknown";
}
