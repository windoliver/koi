/**
 * @koi/channel-whatsapp — outbound Cloud API POST.
 *
 * POSTs to `${graphBaseUrl}/${phoneNumberId}/messages`. Failures are
 * classified by status:
 *  - 401 → INVALID_TOKEN (the access token expired or was revoked)
 *  - 429 → RATE_LIMITED (caller should backoff)
 *  - any other non-2xx + network errors → SEND_FAILED
 */

import type { WhatsAppConfig } from "./config.js";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SendErrorCode = "INVALID_TOKEN" | "RATE_LIMITED" | "SEND_FAILED";

export type SendError = {
  readonly code: SendErrorCode;
  readonly message: string;
  readonly context: { readonly status: number };
};

export type SendOk = { readonly wamid: string };

export type SendResult =
  | { readonly ok: true; readonly value: SendOk }
  | { readonly ok: false; readonly error: SendError };

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function classify(status: number): SendErrorCode {
  if (status === 401) return "INVALID_TOKEN";
  if (status === 429) return "RATE_LIMITED";
  return "SEND_FAILED";
}

export async function sendWhatsAppMessage(
  fetchFn: FetchFn,
  config: WhatsAppConfig,
  payload: object,
): Promise<SendResult> {
  const base = trimTrailingSlash(config.graphBaseUrl);
  const url = `${base}/${encodeURIComponent(config.phoneNumberId)}/messages`;

  // `let` justified: assigned inside try/catch.
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
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
        code: classify(response.status),
        message: `HTTP ${response.status}`,
        context: { status: response.status },
      },
    };
  }

  // `let` justified: parse body in try/catch.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  const wamid = extractWamid(body);
  return { ok: true, value: { wamid } };
}

function extractWamid(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body)) return "";
  const arr = (body as { readonly messages?: unknown }).messages;
  if (!Array.isArray(arr) || arr.length === 0) return "";
  const first: unknown = arr[0];
  if (typeof first !== "object" || first === null || !("id" in first)) return "";
  const id = (first as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : "";
}
