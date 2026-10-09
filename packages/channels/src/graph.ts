import { WhatsAppSendError, classifyApiError, classifyNetworkError } from "./errors.ts";

/**
 * One Graph API request with Node's fetch: bearer token, JSON in and out, a timeout, and
 * Meta's error body turned into a classified WhatsAppSendError. The token is used for
 * this request only and never logged.
 */

export interface GraphOptions {
  /** https://graph.facebook.com (tests use a local fake). */
  baseUrl: string;
  /** e.g. "v24.0" — from META_GRAPH_VERSION, never hard-coded. */
  graphVersion: string;
  timeoutMs?: number;
}

export interface GraphResponse {
  status: number;
  json: Record<string, unknown> | null;
}

export async function graphRequest(
  options: GraphOptions,
  request: {
    method: "GET" | "POST";
    /** Path after the version, e.g. "/123/messages". */
    path: string;
    accessToken: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  },
): Promise<GraphResponse> {
  const query = request.query ? `?${new URLSearchParams(request.query).toString()}` : "";
  const url = `${options.baseUrl}/${options.graphVersion}${request.path}${query}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const kind = classifyNetworkError(error);
    throw new WhatsAppSendError(`request to Meta failed (${kind})`, { kind, cause: error });
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw metaApiError(response.status, json);
  return { status: response.status, json };
}

/** Meta error body: { error: { message, type, code, error_subcode, error_data, fbtrace_id } }. */
export function metaApiError(
  httpStatus: number,
  json: Record<string, unknown> | null,
): WhatsAppSendError {
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
