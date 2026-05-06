/**
 * @koi/channel-teams — `createTeamsChannel` factory.
 *
 * Composes Bot Framework webhook ingress + outbound activity POST into a
 * `ChannelAdapter`. Auth, normalize, and address persistence live here;
 * dedupe + handler dispatch are delegated to channel-base.
 */

import {
  type ConversationAddress,
  type ConversationAddressStore,
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
import type { TeamsConfig } from "./config.js";
import { formatOutbound } from "./format.js";
import { type Activity, normalizeActivity } from "./normalize.js";
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

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_INFLIGHT_WAIT_MS = 2_000;

function dedupeKey(activity: Activity, fallbackTenant: string): string {
  const tid = activity.conversation.tenantId ?? fallbackTenant;
  return `${activity.channelId}|${tid}|${activity.conversation.id}|${activity.id}`;
}

type HandlerRef = { current: MessageHandler | null };

function dispatchInbound(
  ref: HandlerRef,
): (item: { readonly normalized: InboundMessage }) => Promise<void> {
  return async ({ normalized }) => {
    const handler = ref.current;
    if (handler) await handler(normalized);
  };
}

function buildVerify(deps: TeamsDependencies): (request: Request) => Promise<IngressVerifyResult> {
  return async (request) => {
    // `let` justified: body capture inside try/catch.
    let raw: string;
    try {
      raw = await request.clone().text();
    } catch {
      return { ok: false, status: 401, message: "unreadable body" };
    }
    // `let` justified: parse may throw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, status: 401, message: "invalid json" };
    }
    const serviceUrl =
      typeof parsed === "object" &&
      parsed !== null &&
      "serviceUrl" in parsed &&
      typeof parsed.serviceUrl === "string"
        ? parsed.serviceUrl
        : "";
    const auth = request.headers.get("authorization") ?? "";
    const r = await deps.tokenVerifier.verify(auth, { serviceUrl });
    if (!r.ok) return { ok: false, status: 401, message: r.code };
    return { ok: true };
  };
}

function buildParsePayload(
  config: TeamsConfig,
  deps: TeamsDependencies,
  clock: () => number,
): (
  request: Request,
) => Promise<{ readonly payload: Activity; readonly normalized: InboundMessage }> {
  return async (request) => {
    const body = await request.text();
    const parsed = JSON.parse(body) as Activity;
    const norm = normalizeActivity(parsed, clock);
    if (!norm.ok) {
      throw new Error(`INVALID_ACTIVITY: ${norm.error.message}`);
    }
    const tenantId = parsed.conversation.tenantId ?? config.tenantAllowlist[0] ?? "";
    const address: ConversationAddress = {
      serviceUrl: parsed.serviceUrl,
      tenantId,
      channelId: parsed.channelId,
      recipient: {
        id: parsed.from.id,
        ...(parsed.from.name !== undefined ? { name: parsed.from.name } : {}),
      },
      lastSeenAt: clock(),
    };
    await deps.conversationAddressStore.put(parsed.conversation.id, address);
    return { payload: parsed, normalized: norm.value };
  };
}

export function createTeamsChannel(
  config: TeamsConfig,
  deps: TeamsDependencies,
): TeamsChannelAdapter {
  const clock = deps.clock ?? Date.now;
  const handlerRef: HandlerRef = { current: null };
  const fallbackTenant = config.tenantAllowlist[0] ?? "";

  // `let` justified: lifecycle handles set inside connect/disconnect.
  let stopWorker: (() => Promise<void>) | null = null;
  let connected = false;

  const verify = buildVerify(deps);
  const parsePayload = buildParsePayload(config, deps, clock);

  const handleHttpRequest = async (request: Request): Promise<Response> => {
    return handleWebhookIngress<Activity, InboundMessage>({
      request,
      verify,
      extractKey: (activity) => dedupeKey(activity, fallbackTenant),
      parsePayload,
      idempotencyStore: deps.idempotencyStore,
      ingressQueue: deps.ingressQueue,
      leaseMs: DEFAULT_LEASE_MS,
      inFlightWaitMs: DEFAULT_INFLIGHT_WAIT_MS,
    });
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
      const conversationId = message.threadId;
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new Error(
          "CONVERSATION_ADDRESS_UNKNOWN: send() requires message.threadId (the Teams conversation id)",
        );
      }
      const address = await deps.conversationAddressStore.get(conversationId);
      if (address === null) {
        throw new Error(
          `CONVERSATION_ADDRESS_UNKNOWN: no stored address for conversation ${conversationId}`,
        );
      }
      const bearer = await deps.tokenVerifier.appToken();
      const payload = formatOutbound(message);
      const r = await sendActivity(deps.fetch, address, conversationId, bearer, { ...payload });
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
