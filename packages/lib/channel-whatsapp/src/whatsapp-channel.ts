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

export type WhatsAppIngressIssue =
  | { readonly kind: "envelope-unrecognized"; readonly rawBody: string }
  | { readonly kind: "malformed-entry"; readonly count: number }
  | {
      readonly kind: "all-invalid-batch";
      readonly rawBody: string;
      readonly malformedCount: number;
    }
  | { readonly kind: "phone-number-mismatch"; readonly expected: string; readonly got: string }
  | { readonly kind: "normalize-failed"; readonly reason: string };

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

type ExtractedMessage = {
  readonly message: WhatsAppMessage;
  readonly phoneNumberId: string;
};

type ExtractResult = {
  readonly messages: readonly ExtractedMessage[];
  readonly malformedCount: number;
  /**
   * True when the top-level shape is recognizable as a Meta WhatsApp
   * webhook envelope (`object: "whatsapp_business_account"` or at
   * minimum a non-empty `entry[]` array). False indicates the
   * payload is so malformed we cannot tell whether it was supposed
   * to carry messages or be a status callback — surface as a
   * non-2xx so envelope-shape drift / proxy truncation is visible.
   */
  readonly envelopeRecognized: boolean;
};

/**
 * Walks the Meta webhook envelope and yields each `messages[]` entry
 * paired with the `metadata.phone_number_id` of the change it came from.
 * Webhook recipients can be subscribed to events for multiple WABA
 * numbers, and Meta occasionally misroutes — every message MUST be
 * scoped to the WABA-id Meta actually delivered it under, NOT to the
 * adapter's static config value, so cross-number traffic cannot collide
 * on dedupe keys or be sent from the wrong business number on reply.
 *
 * Reports `malformedCount` separately so the caller can distinguish a
 * status-only delivery (no `messages[]`) from one whose `messages[]`
 * carries structurally bad entries; the latter should surface as
 * INVALID_PAYLOAD instead of an empty 200.
 */
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
      if (typeof change !== "object" || change === null || !("value" in change)) continue;
      const value: unknown = change.value;
      if (typeof value !== "object" || value === null) continue;
      const meta =
        "metadata" in value && typeof value.metadata === "object" && value.metadata !== null
          ? (value.metadata as Record<string, unknown>)
          : null;
      const phoneNumberId =
        meta && typeof meta.phone_number_id === "string" ? meta.phone_number_id : null;
      if (!("messages" in value)) {
        // No messages on this change — status callback or other
        // notification. metadata.phone_number_id absence is expected
        // here and not a malformed condition.
        continue;
      }
      const msgs: unknown = value.messages;
      if (!Array.isArray(msgs)) continue;
      if (phoneNumberId === null) {
        // messages[] present but metadata.phone_number_id missing:
        // this is schema drift / partial corruption on a message-
        // bearing webhook. Counting each message as malformed
        // surfaces the failure via onIngressIssue and triggers a
        // 4xx response upstream — silently 200-acking would lose
        // every contained user message with no operator signal.
        malformed += msgs.length;
        continue;
      }
      for (const m of msgs) {
        if (isWhatsAppMessage(m)) {
          out.push({ message: m, phoneNumberId });
        } else {
          malformed++;
        }
      }
    }
  }
  return { messages: out, malformedCount: malformed, envelopeRecognized: true };
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
  // The hook is the operator's durable dead-letter surface; without it,
  // a provider schema regression would lose every affected message.
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

  const handleHttpRequest = async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      // GET handshake (Meta verification) does not need a worker —
      // it answers from config alone, so we deliberately allow it
      // pre-connect. POST is gated below.
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
    // Lifecycle gate (post-auth): once signature is verified we know
    // this is a valid Meta delivery; if no worker is running we 503
    // so Meta retries instead of 200-acking into a void. Auth and
    // parse failures above still return 401/400 even pre-connect.
    if (!connected) {
      return new Response("CHANNEL_NOT_CONNECTED", { status: 503 });
    }
    const extracted = extractMessages(parsed);
    if (!extracted.envelopeRecognized) {
      // Top-level shape drift (missing `entry`, non-array `entry`,
      // proxy truncation, schema regression). We cannot tell whether
      // this delivery was meant to carry messages or be a status
      // callback. Surface the raw body via onIngressIssue so
      // operators can persist it for replay, then 200-ack — Meta
      // does NOT retry 4xx, so a 400 here would permanently drop
      // any contained user messages. The issue surface is the
      // operator's dead-letter feed; production callers are
      // required to provide the hook.
      deps.onIngressIssue?.({ kind: "envelope-unrecognized", rawBody: raw });
      return new Response(null, { status: 200 });
    }
    if (extracted.malformedCount > 0) {
      // Surface malformed-entry count via the ingress-issue hook so
      // operators see the producer regression, but do NOT 400 the
      // whole batch — that would also discard structurally-valid
      // sibling messages in the same delivery. Meta does not retry
      // 4xx, so combining valid-and-invalid in one batch and rejecting
      // the lot is strict data loss for the valid subset.
      deps.onIngressIssue?.({ kind: "malformed-entry", count: extracted.malformedCount });
    }

    // Step 1: per-message validation. Invalid entries (mismatched
    // phone_number_id, normalize failure) are dropped from the batch
    // and surfaced via onIngressIssue. Valid entries continue. This
    // matches the Bot-Framework / SMTP convention of partial-success +
    // structured failure reporting instead of all-or-nothing 4xx, which
    // is the strictly worse choice when the provider does not retry.
    type Item = {
      readonly msg: WhatsAppMessage;
      readonly key: string;
      readonly normalized: InboundMessage;
    };
    const items: Item[] = [];
    for (const { message: msg, phoneNumberId } of extracted.messages) {
      if (phoneNumberId !== config.phoneNumberId) {
        deps.onIngressIssue?.({
          kind: "phone-number-mismatch",
          expected: config.phoneNumberId,
          got: phoneNumberId,
        });
        continue;
      }
      const norm = normalizeWhatsApp(msg, phoneNumberId, clock);
      if (!norm.ok) {
        deps.onIngressIssue?.({ kind: "normalize-failed", reason: norm.error.message });
        continue;
      }
      items.push({ msg, key: dedupeKey(phoneNumberId, msg), normalized: norm.value });
    }
    if (items.length === 0) {
      // Nothing valid to enqueue.
      //   (a) all-malformed batch (malformedCount > 0 and zero
      //       valid siblings): surface the raw body via
      //       onIngressIssue(all-invalid-batch) so operators can
      //       persist it for replay, then 200-ack. 4xx would
      //       permanently drop every contained user message
      //       because Meta does not retry 4xx. Production callers
      //       are required to provide the hook.
      //   (b) empty batch / status callback / phone_number_id
      //       mismatch: 200-ack so Meta stops retrying. Issues
      //       already surfaced via onIngressIssue.
      if (extracted.malformedCount > 0) {
        deps.onIngressIssue?.({
          kind: "all-invalid-batch",
          rawBody: raw,
          malformedCount: extracted.malformedCount,
        });
      }
      return new Response(null, { status: 200 });
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
