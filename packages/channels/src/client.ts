import { WhatsAppSendError } from "./errors.ts";
import { graphRequest, type GraphOptions } from "./graph.ts";

/**
 * WhatsApp Cloud API sender: POST /{version}/{phone-number-id}/messages (Meta's Message API
 * reference). Uses Node's fetch; the Graph version and base URL come from config.
 */

export type WhatsAppClientOptions = GraphOptions;

export interface Sender {
  phoneNumberId: string;
  /** Decrypted channel token; used for this request only, never logged. */
  accessToken: string;
}

export interface SendResult {
  waMessageId: string;
  /** Meta's pacing status, e.g. "accepted" or "held_for_quality_assessment". */
  messageStatus: string | null;
}

export interface TemplateMessage {
  to: string;
  /** Meta template name, e.g. "recordatorio_cita_v1". */
  name: string;
  languageCode: string;
  /** Values for {{1}}…{{n}}, in order. */
  bodyParameters: readonly string[];
  /** Payload for each quick-reply button, by button index. */
  quickReplyPayloads: readonly string[];
}

export interface WhatsAppClient {
  sendText(
    sender: Sender,
    message: { to: string; body: string; previewUrl?: boolean },
  ): Promise<SendResult>;
  sendTemplate(sender: Sender, message: TemplateMessage): Promise<SendResult>;
}

export function createWhatsAppClient(options: WhatsAppClientOptions): WhatsAppClient {
  async function post(sender: Sender, body: Record<string, unknown>): Promise<SendResult> {
    const { status, json } = await graphRequest(options, {
      method: "POST",
      path: `/${encodeURIComponent(sender.phoneNumberId)}/messages`,
      accessToken: sender.accessToken,
      body: { messaging_product: "whatsapp", recipient_type: "individual", ...body },
    });
    const messages = json?.messages;
    const first = Array.isArray(messages)
      ? (messages[0] as Record<string, unknown> | undefined)
      : undefined;
    if (typeof first?.id !== "string") {
      // 2xx without a message id: Meta may well have accepted it, so never resend.
      throw new WhatsAppSendError("Meta accepted the request but returned no message id", {
        kind: "unknown",
        httpStatus: status,
      });
    }
    return {
      waMessageId: first.id,
      messageStatus: typeof first.message_status === "string" ? first.message_status : null,
    };
  }

  return {
    sendText(sender, message) {
      return post(sender, {
        to: message.to,
        type: "text",
        text: { body: message.body, preview_url: message.previewUrl ?? false },
      });
    },

    sendTemplate(sender, message) {
      const components: Record<string, unknown>[] = [];
      if (message.bodyParameters.length > 0) {
        components.push({
          type: "body",
          parameters: message.bodyParameters.map((text) => ({ type: "text", text })),
        });
      }
      message.quickReplyPayloads.forEach((payload, index) => {
        components.push({
          type: "button",
          sub_type: "quick_reply",
          index: String(index),
          parameters: [{ type: "payload", payload }],
        });
      });
      return post(sender, {
        to: message.to,
        type: "template",
        template: { name: message.name, language: { code: message.languageCode }, components },
      });
    },
  };
}
