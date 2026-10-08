import { WhatsAppSendError, classifyApiError, classifyNetworkError } from "./errors.ts";

/**
 * WhatsApp Cloud API sender: POST /{version}/{phone-number-id}/messages (Meta's Message API
 * reference). Uses Node's fetch; the Graph version and base URL come from config.
 */

export interface WhatsAppClientOptions {
  /** https://graph.facebook.com (tests use a local fake). */
  baseUrl: string;
  /** e.g. "v24.0" — from META_GRAPH_VERSION, never hard-coded. */
  graphVersion: string;
  timeoutMs?: number;
}

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
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post(sender: Sender, body: Record<string, unknown>): Promise<SendResult> {
    const url = `${options.baseUrl}/${options.graphVersion}/${encodeURIComponent(sender.phoneNumberId)}/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sender.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...body,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = classifyNetworkError(error);
      throw new WhatsAppSendError(`request to Meta failed (${kind})`, { kind, cause: error });
    }

    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw apiError(response.status, json);

    const messages = json?.messages;
    const first = Array.isArray(messages)
      ? (messages[0] as Record<string, unknown> | undefined)
      : undefined;
    if (typeof first?.id !== "string") {
      // 2xx without a message id: Meta may well have accepted it, so never resend.
      throw new WhatsAppSendError("Meta accepted the request but returned no message id", {
        kind: "unknown",
        httpStatus: response.status,
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

/** Meta error body: { error: { message, type, code, error_subcode, error_data, fbtrace_id } }. */
function apiError(httpStatus: number, json: Record<string, unknown> | null): WhatsAppSendError {
  const error = (json?.error ?? {}) as Record<string, unknown>;
  const code = typeof error.code === "number" ? error.code : null;
  const data = (error.error_data ?? {}) as Record<string, unknown>;
  return new WhatsAppSendError(
    typeof error.message === "string" ? error.message : `Meta responded ${httpStatus}`,
    {
      kind: classifyApiError(httpStatus, code),
      httpStatus,
      code,
      subcode: typeof error.error_subcode === "number" ? error.error_subcode : null,
      details: typeof data.details === "string" ? data.details : null,
      fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id : null,
    },
  );
}
