import { describe, expect, it } from "vitest";
import { signWebhookBody, verifySubscription, verifyWebhookSignature } from "./signature.ts";

const secret = "app-secret-0123456789abcdef";
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe("verifyWebhookSignature", () => {
  it("accepts Meta's sha256= HMAC of the raw body", () => {
    expect(verifyWebhookSignature(body, signWebhookBody(body, secret), secret)).toBe(true);
  });

  it.each([
    ["missing header", undefined],
    ["no prefix", signWebhookBody(body, secret).slice("sha256=".length)],
    ["wrong secret", signWebhookBody(body, "another-secret-0123456789")],
    ["truncated", signWebhookBody(body, secret).slice(0, 20)],
    ["not hex", "sha256=zzzz"],
  ])("rejects %s", (_name, header) => {
    expect(verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it("rejects a body changed after signing, even by whitespace", () => {
    const header = signWebhookBody(body, secret);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyWebhookSignature(reformatted, header, secret)).toBe(false);
  });
});

describe("verifySubscription", () => {
  const token = "verify-token-0123456789";

  it("returns the challenge for a matching subscribe request", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": token,
      "hub.challenge": "1158201444",
    };
    expect(verifySubscription(query, token)).toBe("1158201444");
  });

  it.each([
    { "hub.mode": "subscribe", "hub.verify_token": "wrong-token-0123456789", "hub.challenge": "1" },
    { "hub.mode": "unsubscribe", "hub.verify_token": token, "hub.challenge": "1" },
    { "hub.mode": "subscribe", "hub.verify_token": token },
    {},
  ])("refuses %j", (query) => {
    expect(verifySubscription(query, token)).toBeNull();
  });
});
