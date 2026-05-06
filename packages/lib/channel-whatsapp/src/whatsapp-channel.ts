/**
 * @koi/channel-whatsapp — `createWhatsAppChannel` factory.
 *
 * Composes Meta Cloud API webhook ingress (HMAC-verified) + Graph API send
 * into a `ChannelAdapter`. Webhook handshake (GET) and signature
 * verification (POST) live here; dedupe + handler dispatch are delegated to
 * channel-base.
 *
 * Idempotency key per spec: `${phone_number_id}|${messages[].id}` (WAMID).
 * Meta does not include a freshness timestamp on the envelope, so replay
 * protection is durable WAMID-based dedupe (no time-window check).
 *
 * v1 scope: text-only outbound. Inbound webhooks may contain multiple
 * messages — every message is normalized + enqueued under its own WAMID
 * dedupe key before the HTTP 200 ack. Meta retries the full webhook on
 * non-2xx, so any single enqueue failure returns 5xx; retries converge
 * because enqueue is idempotent on dedupe key.
 */

import { type IdempotencyStore, type IngressQueue, startHandlerWorker } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import type { WhatsAppConfig } from "./config.js";
import { formatOutbound } from "./format.js";
import { normalizeWhatsApp, type WhatsAppMessage } from "./normalize.js";
import { type FetchFn, sendWhatsAppMessage } from "./platform-send.js";
import { verifyMetaSignature } from "./verify-signature.js";

export type WhatsAppErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_SIGNATURE"
  | "INVALID_TOKEN"
  | "INVALID_PAYLOAD"
  | "RATE_LIMITED"
  | "SEND_FAILED"
  | "UNSUPPORTED_BLOCK";

export type WhatsAppDependencies = {
  readonly fetch: FetchFn;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<WhatsAppMessage, InboundMessage>;
  readonly clock?: () => number;
};

export type WhatsAppChannelAdapter = ChannelAdapter & {
  readonly handleHttpRequest: (request: Request) => Promise<Response>;
};

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: false,
  audio: true,
  video: false,
  threads: true,
  supportsA2ui: false,
};

const SIGNATURE_HEADER = "x-hub-signature-256";
const WEBHOOK_LEASE_MS = 30_000;

type HandlerRef = { current: MessageHandler | null };

function dispatchInbound(
  ref: HandlerRef,
): (item: { readonly normalized: InboundMessage }, signal: AbortSignal) => Promise<void> {
  return async ({ normalized }, signal) => {
    if (signal.aborted) return;
    const handler = ref.current;
    if (handler) await handler(normalized);
  };
}

function dedupeKey(phoneNumberId: string, message: WhatsAppMessage): string {
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

function pickFirstMessage(parsed: unknown): readonly WhatsAppMessage[] {
  if (typeof parsed !== "object" || parsed === null || !("entry" in parsed)) return [];
  const entry: unknown = parsed.entry;
  if (!Array.isArray(entry)) return [];
  const messages: WhatsAppMessage[] = [];
  for (const e of entry) {
    if (typeof e !== "object" || e === null || !("changes" in e)) continue;
    const changes: unknown = e.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (typeof change !== "object" || change === null || !("value" in change)) continue;
      const value: unknown = change.value;
      if (typeof value !== "object" || value === null || !("messages" in value)) continue;
      const msgs: unknown = value.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (isWhatsAppMessage(m)) messages.push(m);
      }
    }
  }
  return messages;
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

export function createWhatsAppChannel(
  config: WhatsAppConfig,
  deps: WhatsAppDependencies,
): WhatsAppChannelAdapter {
  const clock = deps.clock ?? Date.now;
  const handlerRef: HandlerRef = { current: null };

  // `let` justified: lifecycle handles set inside connect/disconnect.
  let stopWorker: (() => Promise<void>) | null = null;
  let connected = false;

  const handleHttpRequest = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      const r = await handleHandshake(request, config);
      if (r) return r;
    }
    // POST: read raw body once, verify signature, then enqueue ALL messages
    // in the batch. Meta retries the full webhook on non-2xx, so we cannot
    // ack 200 until every message is durably enqueued (or already deduped).
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
    const messages = pickFirstMessage(parsed);
    if (messages.length === 0) {
      // No messages (status callback or unknown shape) — ack so Meta stops retrying.
      return new Response(null, { status: 200 });
    }

    // Step 1: validate ALL messages in the batch BEFORE any persistence.
    // A single bad message must fail the whole webhook with 400 — no
    // partial-persist + 4xx split, which would silently drop later items
    // because Meta does not retry 4xx.
    type Item = {
      readonly msg: WhatsAppMessage;
      readonly key: string;
      readonly normalized: InboundMessage;
    };
    const items: Item[] = [];
    for (const msg of messages) {
      const norm = normalizeWhatsApp(msg, config.phoneNumberId, clock);
      if (!norm.ok) {
        return new Response(`INVALID_PAYLOAD: ${norm.error.message}`, { status: 400 });
      }
      items.push({ msg, key: dedupeKey(config.phoneNumberId, msg), normalized: norm.value });
    }

    // Step 2: probe IdempotencyStore + enqueue per message. All items are
    // already known-valid, so any failure here is transient store/dedupe
    // pressure → 503 so Meta retries the whole batch (enqueue is
    // idempotent on dedupe key, so retries converge).
    //
    //   - committed              → already processed, skip
    //   - in-flight / capacity   → 503 (Meta retries whole batch)
    //   - ok → enqueue → abort lease (worker re-claims via tryBegin)
    for (const item of items) {
      const begin = await deps.idempotencyStore.tryBegin(item.key, WEBHOOK_LEASE_MS);
      if (!begin.ok) {
        if (begin.reason === "committed") continue;
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
  };

  const adapter: WhatsAppChannelAdapter = {
    name: "whatsapp",
    capabilities: WHATSAPP_CAPABILITIES,

    connect: async () => {
      if (connected) return;
      stopWorker = startHandlerWorker({
        queue: deps.ingressQueue,
        idempotencyStore: deps.idempotencyStore,
        handler: dispatchInbound(handlerRef),
        commitTtlMs: config.commitTtlMs,
        handlerTimeoutMs: config.handlerTimeoutMs,
        workerId: `whatsapp-${crypto.randomUUID()}`,
      });
      connected = true;
    },

    disconnect: async () => {
      if (!connected) return;
      const stop = stopWorker;
      stopWorker = null;
      if (stop) await stop();
      connected = false;
    },

    send: async (message: OutboundMessage) => {
      const recipient = message.threadId;
      if (typeof recipient !== "string" || recipient.length === 0) {
        throw new Error(
          "INVALID_PAYLOAD: send() requires message.threadId (the recipient phone number)",
        );
      }
      const ctxId =
        typeof message.metadata?.contextMessageId === "string"
          ? message.metadata.contextMessageId
          : undefined;
      const payload = formatOutbound({
        message,
        recipient,
        ...(ctxId !== undefined ? { contextMessageId: ctxId } : {}),
      });
      const r = await sendWhatsAppMessage(deps.fetch, config, payload);
      if (!r.ok) {
        throw new Error(`${r.error.code}: ${r.error.message}`, { cause: r.error });
      }
    },

    onMessage: (handler: MessageHandler) => {
      handlerRef.current = handler;
      return () => {
        if (handlerRef.current === handler) handlerRef.current = null;
      };
    },

    handleHttpRequest,
  };

  return adapter;
}
