import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook POST: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw
 * body, keyed with the app secret>`. Verify against the exact bytes received, before any
 * JSON parsing.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** The header value Meta would send for this body. Used by tests and the fake Graph API. */
export function signWebhookBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/**
 * Webhook subscription check (GET): when `hub.mode` is "subscribe" and `hub.verify_token`
 * matches ours, answer 200 with `hub.challenge`. Returns the challenge, or null to refuse.
 */
export function verifySubscription(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string")
    return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}
