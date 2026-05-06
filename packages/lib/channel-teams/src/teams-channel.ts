/**
 * @koi/channel-teams — `createTeamsChannel` factory.
 *
 * Composes Bot Framework webhook ingress + outbound activity POST into a
 * `ChannelAdapter`. Auth, normalize, and address persistence live here;
 * dedupe + handler dispatch are delegated to channel-base.
 */

import {
  assertDurableInProduction,
  type ConversationAddress,
  type ConversationAddressStore,
  type IdempotencyStore,
  type IngressQueue,
  type Lease,
  startHandlerWorker,
} from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import type { TeamsConfig } from "./config.js";
import { formatOutbound } from "./format.js";
import {
  type Activity,
  composeConversationKey,
  isActivity,
  normalizeActivity,
} from "./normalize.js";
import { type FetchFn, sendActivity } from "./platform-send.js";
import type { JwtVerifier } from "./verify-jwt.js";

export type TeamsErrorCode =
  | "INVALID_CONFIG"
  | "AUTH_FAILED"
  | "INVALID_JWT"
  | "AUDIENCE_MISMATCH"
  | "TENANT_NOT_ALLOWED"
  | "SERVICE_URL_NOT_ALLOWED"
  | "INVALID_ACTIVITY"
  | "SEND_FAILED"
  | "CONVERSATION_ADDRESS_UNKNOWN";

export type TeamsDependencies = {
  readonly tokenVerifier: JwtVerifier;
  readonly fetch: FetchFn;
  readonly idempotencyStore: IdempotencyStore;
  readonly conversationAddressStore: ConversationAddressStore;
  readonly ingressQueue: IngressQueue<Activity, InboundMessage>;
  readonly clock?: () => number;
};

export type TeamsChannelAdapter = ChannelAdapter & {
  readonly handleHttpRequest: (request: Request) => Promise<Response>;
};

const TEAMS_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

const WEBHOOK_LEASE_MS = 30_000;
const INFLIGHT_WAIT_MS = 2_000;

function dedupeKey(channelId: string, tenantId: string, activity: Activity): string {
  return `${channelId}|${tenantId}|${activity.conversation.id}|${activity.id}`;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createTeamsChannel(
  config: TeamsConfig,
  deps: TeamsDependencies,
): TeamsChannelAdapter {
  const guard = assertDurableInProduction(config.production, [
    { name: "idempotencyStore", store: deps.idempotencyStore },
    { name: "ingressQueue", store: deps.ingressQueue },
    { name: "conversationAddressStore", store: deps.conversationAddressStore },
  ]);
  if (!guard.ok) {
    throw new Error(`${guard.error.code}: ${guard.error.message}`);
  }
  const clock = deps.clock ?? Date.now;
  const handlerRef: HandlerRef = { current: null };
  const fallbackTenant = config.tenantAllowlist[0] ?? "";

  // `let` justified: lifecycle handles set inside connect/disconnect.
  let stopWorker: (() => Promise<void>) | null = null;
  let connected = false;

  const handleHttpRequest = async (request: Request): Promise<Response> => {
    // Read body once; verify JWT against header + serviceUrl; if any
    // verified-claim disagreement with body fields, reject. Routing keys
    // are derived from VERIFIED claims (not body), so a tampered body
    // cannot point a reply at the wrong tenant.
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return new Response("unreadable body", { status: 400 });
    }
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    // Validate structural shape BEFORE dereferencing nested fields, so
    // a malformed-but-authenticated payload produces a deterministic
    // 400 / INVALID_ACTIVITY rather than a TypeError-driven 500 (which
    // Bot Framework would retry indefinitely).
    if (!isActivity(parsedRaw)) {
      return new Response("INVALID_ACTIVITY: malformed activity shape", { status: 400 });
    }
    const parsed: Activity = parsedRaw;
    const auth = request.headers.get("authorization") ?? "";
    const verifyResult = await deps.tokenVerifier.verify(auth, {
      serviceUrl: parsed.serviceUrl,
    });
    if (!verifyResult.ok) {
      return new Response(verifyResult.code, { status: 401 });
    }
    // Bind routing identity to the verified `tid` claim. If the body's
    // tenantId is present and disagrees with the claim, reject — that is
    // a tenant-isolation guarantee, not a parser nicety.
    const verifiedTid = verifyResult.claims.tid;
    const bodyTid = parsed.conversation.tenantId;
    if (typeof bodyTid === "string" && bodyTid !== verifiedTid) {
      return new Response("tenant-claim-mismatch", { status: 401 });
    }
    const tenantId = verifiedTid;
    const norm = normalizeActivity(parsed, clock, fallbackTenant);
    if (!norm.ok) {
      return new Response(`INVALID_ACTIVITY: ${norm.error.message}`, { status: 400 });
    }
    // Re-derive the threadId from VERIFIED claims so it matches the
    // address-store key written below.
    const addressKey = composeConversationKey(parsed.channelId, tenantId, parsed.conversation.id);
    const normalized: InboundMessage = { ...norm.value, threadId: addressKey };

    const key = dedupeKey(parsed.channelId, tenantId, parsed);

    // Claim BEFORE side-effectful persistence: a duplicate/replay must
    // not be allowed to overwrite the stored conversation address.
    const begin = await deps.idempotencyStore.tryBegin(key, WEBHOOK_LEASE_MS);
    if (!begin.ok && begin.reason === "committed") {
      return new Response(null, { status: 200 });
    }
    if (!begin.ok && begin.reason === "in-flight") {
      const t0 = Date.now();
      while (Date.now() - t0 < INFLIGHT_WAIT_MS) {
        await sleep(5);
        const r2 = await deps.idempotencyStore.tryBegin(key, WEBHOOK_LEASE_MS);
        if (!r2.ok && r2.reason === "committed") {
          return new Response(null, { status: 200 });
        }
        if (r2.ok) {
          // We won the race; promote and proceed via the same path below
          // by reassigning `begin` semantics.
          // (keep loop body minimal — fall through after break)
          await persistAndEnqueue(r2.lease);
          return new Response(null, { status: 200 });
        }
      }
      return new Response("in-flight", { status: 503 });
    }
    if (!begin.ok && begin.reason === "capacity-exhausted") {
      return new Response("capacity", { status: 503 });
    }
    if (!begin.ok) return new Response("unknown", { status: 500 });

    await persistAndEnqueue(begin.lease);
    return new Response(null, { status: 200 });

    async function persistAndEnqueue(lease: Lease): Promise<void> {
      // Use the activity's own timestamp (assigned by the source channel)
      // as the monotonic ordering key, falling back to wall-clock if the
      // activity omits one. This is what makes replay-vs-fresh
      // distinguishable: a delayed redelivery of an OLDER activity must
      // not overwrite a NEWER stored serviceUrl/recipient.
      const activityTs =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      const lastSeenAt = Number.isFinite(activityTs) ? activityTs : clock();
      const address: ConversationAddress = {
        serviceUrl: parsed.serviceUrl,
        tenantId,
        channelId: parsed.channelId,
        conversationId: parsed.conversation.id,
        recipient: {
          id: parsed.from.id,
          ...(parsed.from.name !== undefined ? { name: parsed.from.name } : {}),
        },
        lastSeenAt,
      };
      // Monotonic update: only overwrite if the new delivery is at least
      // as recent as the stored one. Bot Framework can rotate serviceUrl,
      // and a replay of an older activity arriving after a newer one
      // would otherwise clobber the fresh routing target.
      const existing = await deps.conversationAddressStore.get(addressKey);
      if (existing === null || existing.lastSeenAt <= lastSeenAt) {
        await deps.conversationAddressStore.put(addressKey, address);
      }
      await deps.ingressQueue.enqueue(key, { key, payload: parsed, normalized });
      await deps.idempotencyStore.abort(lease).catch(() => {});
    }
  };

  const adapter: TeamsChannelAdapter = {
    name: "teams",
    capabilities: TEAMS_CAPABILITIES,

    connect: async () => {
      if (connected) return;
      stopWorker = startHandlerWorker({
        queue: deps.ingressQueue,
        idempotencyStore: deps.idempotencyStore,
        handler: dispatchInbound(handlerRef),
        commitTtlMs: config.commitTtlMs,
        handlerTimeoutMs: config.handlerTimeoutMs,
        workerId: `teams-${crypto.randomUUID()}`,
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
      const addressKey = message.threadId;
      if (typeof addressKey !== "string" || addressKey.length === 0) {
        throw new Error(
          "CONVERSATION_ADDRESS_UNKNOWN: send() requires message.threadId (the composite Teams routing key)",
        );
      }
      const address = await deps.conversationAddressStore.get(addressKey);
      if (address === null) {
        throw new Error(
          `CONVERSATION_ADDRESS_UNKNOWN: no stored address for routing key ${addressKey}`,
        );
      }
      const bearer = await deps.tokenVerifier.appToken();
      const payload = formatOutbound(message);
      const r = await sendActivity(deps.fetch, address, address.conversationId, bearer, {
        ...payload,
      });
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
