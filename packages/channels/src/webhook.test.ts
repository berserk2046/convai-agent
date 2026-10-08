import { describe, expect, it } from "vitest";
import { webhookFixture } from "./testing.ts";
import { parseWebhook, type InboundMessage, type WebhookEvent } from "./webhook.ts";

function events(fixture: Parameters<typeof webhookFixture>[0]): WebhookEvent[] {
  const result = parseWebhook(webhookFixture(fixture));
  if (!result.ok) throw new Error(result.error);
  return result.events;
}

function onlyMessage(fixture: Parameters<typeof webhookFixture>[0]): InboundMessage {
  const [event] = events(fixture);
  if (event?.kind !== "message")
    throw new Error(`expected a message, got ${event?.kind ?? "nothing"}`);
  expect(event.phoneNumberId).toBe("106540352242922");
  return event.message;
}

describe("parseWebhook with Meta's recorded payloads", () => {
  it("text message", () => {
    expect(onlyMessage("text-message")).toMatchObject({
      waMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
      from: "16505551234",
      timestamp: new Date(1749416383 * 1000),
      type: "text",
      text: "Does it come in another color?",
      profileName: "Sheena Nelson",
      actionable: true,
      contextMessageId: null,
    });
  });

  it("template quick-reply tap", () => {
    expect(onlyMessage("button-message")).toMatchObject({
      type: "button",
      text: "Unsubscribe",
      button: { payload: "Unsubscribe", text: "Unsubscribe" },
      contextMessageId: "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=",
      actionable: true,
    });
  });

  it("interactive replies", () => {
    expect(onlyMessage("interactive-button-reply")).toMatchObject({
      text: "Cancel",
      interactive: { kind: "button_reply", id: "cancel-button", title: "Cancel" },
    });
    expect(onlyMessage("interactive-list-reply")).toMatchObject({
      text: "Priority Mail Express",
      interactive: { kind: "list_reply", id: "priority_express" },
    });
  });

  it("image with caption is actionable; the caption is its text", () => {
    expect(onlyMessage("image-message")).toMatchObject({
      type: "image",
      text: "Taj Mahal",
      actionable: true,
    });
  });

  it("reactions, removed reactions and unsupported edits are stored but not answered", () => {
    expect(onlyMessage("reaction-message")).toMatchObject({
      actionable: false,
      text: null,
      reaction: { emoji: "👍" },
    });
    expect(onlyMessage("reaction-removed")).toMatchObject({
      actionable: false,
      reaction: { emoji: null },
    });
    expect(onlyMessage("unsupported-message")).toMatchObject({
      type: "unsupported",
      actionable: false,
    });
  });

  it("status with pricing", () => {
    expect(events("status-sent")).toEqual([
      {
        kind: "status",
        phoneNumberId: "106540352242922",
        status: {
          waMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
          status: "sent",
          timestamp: new Date(1750030073 * 1000),
          recipientId: "16505551234",
          pricing: { billable: true, model: "PMP", type: "regular", category: "marketing" },
          errors: [],
        },
      },
    ]);
    expect(events("status-sent-minimal")[0]).toMatchObject({ status: { pricing: null } });
  });

  it("failed status keeps the error code", () => {
    expect(events("status-failed")[0]).toMatchObject({
      kind: "status",
      status: {
        status: "failed",
        errors: [{ code: 131049, details: expect.stringContaining("healthy ecosystem") }],
      },
    });
  });

  it("flags other webhook fields as unhandled", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }],
        },
      ],
    };
    expect(parseWebhook(payload)).toEqual({
      ok: true,
      events: [{ kind: "unhandled", field: "message_template_status_update", phoneNumberId: null }],
    });
  });

  it("rejects payloads that aren't WhatsApp webhooks", () => {
    expect(parseWebhook({ object: "page", entry: [] }).ok).toBe(false);
    expect(parseWebhook(null).ok).toBe(false);
  });
});
