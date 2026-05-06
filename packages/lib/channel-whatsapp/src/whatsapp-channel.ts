/**
 * @koi/channel-whatsapp — `createWhatsAppChannel` factory.
 *
 * Composes Meta Cloud API webhook ingress (HMAC-verified) + Graph API send
 * into a `ChannelAdapter`. Webhook handshake (GET) and signature
 * verification (POST) live in `pipeline.ts`; dedupe + handler dispatch are
 * delegated to channel-base.
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

import {
  assertDurableInProduction,
  type IdempotencyStore,
  type IngressQueue,
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
import type { WhatsAppMessage } from "./normalize.js";
import {
  dispatchInbound,
  type HandlerRef,
  processWebhookRequest,
  sendOutboundMessage,
  type WhatsAppIngressIssue,
} from "./pipeline.js";
import type { FetchFn } from "./platform-send.js";

export type WhatsAppErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_SIGNATURE"
  | "INVALID_TOKEN"
  | "INVALID_PAYLOAD"
  | "RATE_LIMITED"
  | "SEND_FAILED"
  | "UNSUPPORTED_BLOCK";

export type { WhatsAppIngressIssue } from "./pipeline.js";

export type WhatsAppDependencies = {
  readonly fetch: FetchFn;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<WhatsAppMessage, InboundMessage>;
  readonly clock?: () => number;
  /**
   * Called for each per-message ingress issue (malformed entry, phone-
   * number-id mismatch, normalize failure). Webhook-level batches with
   * mixed-validity entries no longer 400 the entire batch — valid
   * siblings are enqueued and invalid ones surface here for telemetry
   * / dead-letter handling. Default is silent (operators that need
   * visibility MUST supply this hook).
   */
  readonly onIngressIssue?: (issue: WhatsAppIngressIssue) => void;
};

export type WhatsAppChannelAdapter = ChannelAdapter & {
  readonly handleHttpRequest: (request: Request) => Promise<Response>;
};

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  text: true,
  // formatOutbound() currently emits only Cloud API `type: "text"`
  // payloads. Advertising images/files/audio without the corresponding
  // outbound media-upload + send pipeline would silently drop those
  // blocks before the Graph API call — a contract break for callers
  // that route on advertised capabilities. Flip true only when format.ts
  // emits real `type: "image" | "document" | "audio"` payloads.
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

export function createWhatsAppChannel(
  config: WhatsAppConfig,
  deps: WhatsAppDependencies,
): WhatsAppChannelAdapter {
  const guard = assertDurableInProduction(config.production, [
    { name: "idempotencyStore", store: deps.idempotencyStore },
    { name: "ingressQueue", store: deps.ingressQueue },
  ]);
  if (!guard.ok) {
    throw new Error(`${guard.error.code}: ${guard.error.message}`);
  }
  // In production, onIngressIssue MUST be supplied. Webhook batches that
  // are entirely malformed / mismatched / un-normalizable cannot be
  // retried (Meta does not retry 4xx; 5xx would loop forever on poison
  // content) and would otherwise be silently 200-acked into the void.
  if (config.production && deps.onIngressIssue === undefined) {
    throw new Error(
      "MISSING_PRODUCTION_DEPENDENCY: onIngressIssue hook is required in production (operator-visible dead-letter surface for malformed/all-invalid webhook batches)",
    );
  }
  const clock = deps.clock ?? Date.now;
  const handlerRef: HandlerRef = { current: null };

  // `let` justified: lifecycle handles set inside connect/disconnect.
  let stopWorker: (() => Promise<void>) | null = null;
  let connected = false;

  const handleHttpRequest = (request: Request): Promise<Response> =>
    processWebhookRequest({
      request,
      config,
      deps,
      clock,
      handlerRef,
      isConnected: () => connected,
    });

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

    send: (message: OutboundMessage) => sendOutboundMessage(message, config, deps),

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
