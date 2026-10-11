import { randomUUID } from "node:crypto";
import type { SendResult, Sender, TemplateMessage, WhatsAppClient } from "@platform/channels";

/**
 * The mock channel (spec §11): stands in for the WhatsApp Cloud API, accepts every send
 * and keeps what would have gone out. Evals and the playground never reach Meta.
 */

export interface CapturedSend {
  to: string;
  kind: "text" | "template";
  /** Text body, or the template name for templates. */
  body: string;
}

export interface CaptureChannel extends WhatsAppClient {
  readonly sent: readonly CapturedSend[];
}

export function captureChannel(): CaptureChannel {
  const sent: CapturedSend[] = [];
  const accept = (): Promise<SendResult> =>
    Promise.resolve({ waMessageId: `wamid.sandbox.${randomUUID()}`, messageStatus: "accepted" });
  return {
    sent,
    sendText(_sender: Sender, message) {
      sent.push({ to: message.to, kind: "text", body: message.body });
      return accept();
    },
    sendTemplate(_sender: Sender, message: TemplateMessage) {
      sent.push({ to: message.to, kind: "template", body: message.name });
      return accept();
    },
  };
}
