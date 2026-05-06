/**
 * @koi/channel-whatsapp — webhook ingress + outbound-send helpers.
 *
 * Split out of `whatsapp-channel.ts` to keep the factory file under the
 * complexity ratchet. The factory composes these helpers into the
 * ChannelAdapter; the helpers themselves are pure (config + deps in,
 * Response/Promise out) and can be unit-tested in isolation.
 */

import type { IdempotencyStore, IngressQueue } from "@koi/channel-base";
import type { InboundMessage, MessageHandler, OutboundMessage } from "@koi/core";
import type { WhatsAppConfig } from "./config.js";
import { formatOutbound } from "./format.js";
import { normalizeWhatsApp, type WhatsAppMessage } from "./normalize.js";
import { type FetchFn, sendWhatsAppMessage } from "./platform-send.js";
import { verifyMetaSignature } from "./verify-signature.js";

export const SIGNATURE_HEADER = "x-hub-signature-256";
export const WEBHOOK_LEASE_MS = 30_000;

export type WhatsAppIngressIssue =
  | { readonly kind: "envelope-unrecognized"; readonly rawBody: string }
  | { readonly kind: "malformed-entry"; readonly count: number }
  | {
      readonly kind: "all-invalid-batch";
      readonly rawBody: string;
      readonly malformedCount: number;
    }
  | {
      readonly kind: "phone-number-mismatch";
      readonly expected: string;
      readonly got: string;
      readonly message: WhatsAppMessage;
    }
  | { readonly kind: "normalize-failed"; readonly reason: string };

export type WhatsAppPipelineDeps = {
  readonly fetch: FetchFn;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<WhatsAppMessage, InboundMessage>;
  readonly onIngressIssue?: (issue: WhatsAppIngressIssue) => void;
};

export type HandlerRef = { current: MessageHandler | null };

export function dispatchInbound(
  ref: HandlerRef,
): (item: { readonly normalized: InboundMessage }, signal: AbortSignal) => Promise<void> {
  return async ({ normalized }, signal) => {
    if (signal.aborted) return;
    const handler = ref.current;
    if (handler === null) {
      // No handler installed: throw so the worker nacks. Treating null as
      // success would silently commit and lose the message.
      throw new Error(
        "NO_HANDLER: onMessage() handler not installed; cannot dispatch inbound message",
      );
    }
    await handler(normalized);
  };
}

export function dedupeKey(phoneNumberId: string, message: WhatsAppMessage): string {
  return `${phoneNumberId}|${message.id}`;
}

function isWhatsAppMessage(v: unknown): v is WhatsAppMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    typeof v.id === "string" &&
    "from" in v &&
    typeof v.from === "string" &&
    "type" in v &&
    typeof v.type === "string"
  );
}

type ExtractedMessage = {
  readonly message: WhatsAppMessage;
  readonly phoneNumberId: string;
};

type ExtractResult = {
  readonly messages: readonly ExtractedMessage[];
  readonly malformedCount: number;
  readonly envelopeRecognized: boolean;
};

type ValidItem = {
  readonly msg: WhatsAppMessage;
  readonly key: string;
  readonly normalized: InboundMessage;
};

export type WebhookCtx = {
  readonly request: Request;
  readonly config: WhatsAppConfig;
  readonly deps: WhatsAppPipelineDeps;
  readonly clock: () => number;
  readonly handlerRef: HandlerRef;
  readonly isConnected: () => boolean;
};

export async function processWebhookRequest(ctx: WebhookCtx): Promise<Response> {
  const { request, config } = ctx;
  if (request.method === "GET") {
    const r = await handleHandshake(request, config);
    if (r) return r;
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response("unreadable body", { status: 400 });
  }
  const sig = verifyMetaSignature({
    rawBody: raw,
    header: request.headers.get(SIGNATURE_HEADER),
    appSecret: config.appSecret,
  });
  if (!sig.ok) return new Response("INVALID_SIGNATURE", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response("INVALID_PAYLOAD", { status: 400 });
  }
  // Lifecycle gate (post-auth): once signature is verified we know this is
  // a valid Meta delivery; if no worker is running we 503 so Meta retries
  // instead of 200-acking into a void.
  if (!ctx.isConnected()) return new Response("CHANNEL_NOT_CONNECTED", { status: 503 });
  return processVerifiedWebhook(ctx, raw, parsed);
}

async function processVerifiedWebhook(
  ctx: WebhookCtx,
  raw: string,
  parsed: unknown,
): Promise<Response> {
  const { config, deps, clock, handlerRef } = ctx;
  const extracted = extractMessages(parsed);
  if (!extracted.envelopeRecognized) {
    // Top-level shape drift: surface raw body and 200-ack. Meta does NOT
    // retry 4xx, so 400 here would permanently drop content.
    deps.onIngressIssue?.({ kind: "envelope-unrecognized", rawBody: raw });
    return new Response(null, { status: 200 });
  }
  if (extracted.malformedCount > 0) {
    deps.onIngressIssue?.({ kind: "malformed-entry", count: extracted.malformedCount });
  }
  const items = filterValidItems(extracted.messages, config, clock, deps.onIngressIssue);
  if (items.length === 0) {
    if (extracted.malformedCount > 0) {
      deps.onIngressIssue?.({
        kind: "all-invalid-batch",
        rawBody: raw,
        malformedCount: extracted.malformedCount,
      });
    }
    return new Response(null, { status: 200 });
  }
  if (handlerRef.current === null) return new Response("NO_HANDLER", { status: 503 });
  return enqueueAllItems(items, deps);
}

async function handleHandshake(request: Request, config: WhatsAppConfig): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && token === config.verifyToken) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

function extractMessages(parsed: unknown): ExtractResult {
  const unrecognized: ExtractResult = {
    messages: [],
    malformedCount: 0,
    envelopeRecognized: false,
  };
  if (typeof parsed !== "object" || parsed === null || !("entry" in parsed)) return unrecognized;
  const entry: unknown = parsed.entry;
  if (!Array.isArray(entry)) return unrecognized;
  const out: ExtractedMessage[] = [];
  let malformed = 0;
  for (const e of entry) {
    if (typeof e !== "object" || e === null || !("changes" in e)) continue;
    const changes: unknown = e.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      malformed += extractFromChange(change, out);
    }
  }
  return { messages: out, malformedCount: malformed, envelopeRecognized: true };
}

function extractFromChange(change: unknown, out: ExtractedMessage[]): number {
  if (typeof change !== "object" || change === null || !("value" in change)) return 0;
  const value: unknown = change.value;
  if (typeof value !== "object" || value === null) return 0;
  const meta =
    "metadata" in value && typeof value.metadata === "object" && value.metadata !== null
      ? (value.metadata as Record<string, unknown>)
      : null;
  const phoneNumberId =
    meta && typeof meta.phone_number_id === "string" ? meta.phone_number_id : null;
  if (!("messages" in value)) return 0;
  const msgs: unknown = value.messages;
  if (!Array.isArray(msgs)) return 0;
  // metadata.phone_number_id missing on a message-bearing change is schema
  // drift; count every contained message as malformed so onIngressIssue
  // fires instead of silently 200-acking lost user input.
  if (phoneNumberId === null) return msgs.length;
  let malformed = 0;
  for (const m of msgs) {
    if (isWhatsAppMessage(m)) out.push({ message: m, phoneNumberId });
    else malformed++;
  }
  return malformed;
}

function filterValidItems(
  messages: readonly ExtractedMessage[],
  config: WhatsAppConfig,
  clock: () => number,
  onIngressIssue: WhatsAppPipelineDeps["onIngressIssue"],
): ValidItem[] {
  const items: ValidItem[] = [];
  for (const { message: msg, phoneNumberId } of messages) {
    if (phoneNumberId !== config.phoneNumberId) {
      onIngressIssue?.({
        kind: "phone-number-mismatch",
        expected: config.phoneNumberId,
        got: phoneNumberId,
        message: msg,
      });
      continue;
    }
    const norm = normalizeWhatsApp(msg, phoneNumberId, clock);
    if (!norm.ok) {
      onIngressIssue?.({ kind: "normalize-failed", reason: norm.error.message });
      continue;
    }
    items.push({ msg, key: dedupeKey(phoneNumberId, msg), normalized: norm.value });
  }
  return items;
}

async function enqueueAllItems(
  items: readonly ValidItem[],
  deps: WhatsAppPipelineDeps,
): Promise<Response> {
  for (const item of items) {
    const begin = await deps.idempotencyStore.tryBegin(item.key, WEBHOOK_LEASE_MS);
    if (!begin.ok) {
      if (begin.reason === "committed" || begin.reason === "poisoned") continue;
      return new Response(begin.reason, { status: 503 });
    }
    try {
      await deps.ingressQueue.enqueue(item.key, {
        key: item.key,
        payload: item.msg,
        normalized: item.normalized,
      });
    } catch {
      await deps.idempotencyStore.abort(begin.lease).catch(() => {});
      return new Response("ingress-queue-unavailable", { status: 503 });
    }
    await deps.idempotencyStore.abort(begin.lease).catch(() => {});
  }
  return new Response(null, { status: 200 });
}

export async function sendOutboundMessage(
  message: OutboundMessage,
  config: WhatsAppConfig,
  deps: WhatsAppPipelineDeps,
): Promise<void> {
  // threadId is composite `${phoneNumberId}|${recipientPhone}` for inbound-
  // derived replies; bare-phone threadIds accepted for proactive legacy sends.
  const tid = message.threadId;
  if (typeof tid !== "string" || tid.length === 0) {
    throw new Error(
      "INVALID_PAYLOAD: send() requires message.threadId (composite '<phoneNumberId>|<recipientPhone>' or bare recipient phone)",
    );
  }
  const sep = tid.indexOf("|");
  let recipient: string;
  if (sep >= 0) {
    const tidPid = tid.slice(0, sep);
    recipient = tid.slice(sep + 1);
    if (tidPid !== config.phoneNumberId) {
      throw new Error(
        `WRONG_BUSINESS_NUMBER: threadId business number "${tidPid}" does not match this channel's phoneNumberId "${config.phoneNumberId}"`,
      );
    }
  } else {
    recipient = tid;
  }
  if (recipient.length === 0) {
    throw new Error("INVALID_PAYLOAD: empty recipient phone in composite threadId");
  }
  const ctxId =
    typeof message.metadata?.contextMessageId === "string"
      ? message.metadata.contextMessageId
      : undefined;
  const formatted = formatOutbound({
    message,
    recipient,
    ...(ctxId !== undefined ? { contextMessageId: ctxId } : {}),
  });
  if (!formatted.ok) {
    throw new Error(`${formatted.error.code}: ${formatted.error.message}`, {
      cause: formatted.error,
    });
  }
  const r = await sendWhatsAppMessage(deps.fetch, config, formatted.value);
  if (!r.ok) {
    throw new Error(`${r.error.code}: ${r.error.message}`, { cause: r.error });
  }
}
