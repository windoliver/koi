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
 * v1 scope: text-only outbound, single-message inbound webhooks. If a Meta
 * delivery contains multiple messages the first is processed via
 * handleWebhookIngress and the remainder are enqueued directly so the
 * handler still sees them — but only the first message's WAMID gates the
 * HTTP response.
 */

import {
  handleWebhookIngress,
  type IdempotencyStore,
  type IngressQueue,
  type VerifyResult as IngressVerifyResult,
  startHandlerWorker,
} from "@koi/channel-base";
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

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_INFLIGHT_WAIT_MS = 2_000;
const SIGNATURE_HEADER = "x-hub-signature-256";

type HandlerRef = { current: MessageHandler | null };

function dispatchInbound(
  ref: HandlerRef,
): (item: { readonly normalized: InboundMessage }) => Promise<void> {
  return async ({ normalized }) => {
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

type RawBodyCache = { value: string | null };

function buildVerify(
  config: WhatsAppConfig,
  cache: RawBodyCache,
): (request: Request) => Promise<IngressVerifyResult> {
  return async (request) => {
    // `let` justified: body capture inside try/catch.
    let raw: string;
    try {
      raw = await request.clone().text();
    } catch {
      return { ok: false, status: 401, message: "unreadable body" };
    }
    cache.value = raw;
    const r = verifyMetaSignature({
      rawBody: raw,
      header: request.headers.get(SIGNATURE_HEADER),
      appSecret: config.appSecret,
    });
    if (!r.ok) return { ok: false, status: 401, message: "INVALID_SIGNATURE" };
    return { ok: true };
  };
}

function buildParsePayload(
  config: WhatsAppConfig,
  cache: RawBodyCache,
  clock: () => number,
): (
  request: Request,
) => Promise<{ readonly payload: WhatsAppMessage; readonly normalized: InboundMessage }> {
  return async (request) => {
    const raw = cache.value ?? (await request.text());
    const parsed: unknown = JSON.parse(raw);
    const messages = pickFirstMessage(parsed);
    const first = messages[0];
    if (first === undefined) {
      throw new Error("INVALID_PAYLOAD: no messages in webhook entry");
    }
    const norm = normalizeWhatsApp(first, config.phoneNumberId, clock);
    if (!norm.ok) throw new Error(`INVALID_PAYLOAD: ${norm.error.message}`);
    return { payload: first, normalized: norm.value };
  };
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
    const cache: RawBodyCache = { value: null };
    return handleWebhookIngress<WhatsAppMessage, InboundMessage>({
      request,
      verify: buildVerify(config, cache),
      extractKey: (msg) => dedupeKey(config.phoneNumberId, msg),
      parsePayload: buildParsePayload(config, cache, clock),
      idempotencyStore: deps.idempotencyStore,
      ingressQueue: deps.ingressQueue,
      leaseMs: DEFAULT_LEASE_MS,
      inFlightWaitMs: DEFAULT_INFLIGHT_WAIT_MS,
    });
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
