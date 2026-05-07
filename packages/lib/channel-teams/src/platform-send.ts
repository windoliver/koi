/**
 * @koi/channel-teams — outbound activity POST.
 *
 * POST `{serviceUrl}/v3/conversations/{conversationId}/activities` with the
 * channel's app-bearer token. Returns a typed Result; transport failures
 * surface as SEND_FAILED with the response status (or 0 for network errors).
 */

import type { ConversationAddress } from "@koi/channel-base";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SendError = {
  readonly code: "SEND_FAILED";
  readonly message: string;
  readonly context: { readonly status: number };
};

export type SendOk = { readonly activityId: string };

export type SendResult =
  | { readonly ok: true; readonly value: SendOk }
  | { readonly ok: false; readonly error: SendError };

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export async function sendActivity(
  fetchFn: FetchFn,
  address: ConversationAddress,
  conversationId: string,
  bearer: string,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  const base = trimTrailingSlash(address.serviceUrl);
  const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
  // `let` justified: response captured inside try/catch.
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "network error";
    return { ok: false, error: { code: "SEND_FAILED", message, context: { status: 0 } } };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "SEND_FAILED",
        message: `HTTP ${response.status}`,
        context: { status: response.status },
      },
    };
  }
  // `let` justified: assignment inside try/catch fallback.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const id =
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
      ? body.id
      : "";
  return { ok: true, value: { activityId: id } };
}
