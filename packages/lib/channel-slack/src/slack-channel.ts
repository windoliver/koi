/**
 * Slack ChannelAdapter — Socket Mode (WebSocket) or HTTP Events API.
 *
 * Built on @koi/channel-base/createChannelAdapter() for shared lifecycle and
 * dispatch. Slack SDKs are loaded lazily via dynamic import so HTTP
 * deployments don't pay the Socket Mode bundle cost.
 *
 * threadId convention:
 *   "C12345"               → channel root
 *   "C12345:1700000000.0"  → in-thread reply (thread_ts = "1700000000.0")
 */

import { createHash } from "node:crypto";
import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ContentBlock, OutboundMessage } from "@koi/core";
import { createNormalizer, type SlackEvent } from "./normalize.js";
import { verifySlackRequest } from "./verify-signature.js";

/** Replay window in `verify-signature.ts` is 5 minutes — match it here. */
const DEDUPE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory dedupe with TTL-only eviction. Slack retries unacked deliveries
 * via `Retry-Num`, and replay attacks within the verification window are
 * still possible after signature checking, so every accepted signed request
 * must pass through this gate before dispatch.
 *
 * Eviction is strictly TTL-based: entries are removed only when their replay
 * window has expired, never to make room. A size-based FIFO cap would let an
 * older still-live `event_id` be evicted right before its retry arrives,
 * defeating the dedupe under sustained traffic. Map insertion order matches
 * expiry order (TTL is fixed), so each `observe` amortizes O(1) sweep of
 * already-expired keys from the front.
 */
function createIngressDedupe(): {
  readonly observe: (key: string, nowMs: number) => boolean;
  readonly size: () => number;
} {
  const seen = new Map<string, number>();
  const sweepExpired = (nowMs: number): void => {
    for (const [k, exp] of seen) {
      if (exp > nowMs) return;
      seen.delete(k);
    }
  };
  return {
    observe: (key: string, nowMs: number): boolean => {
      sweepExpired(nowMs);
      if (seen.has(key)) return true;
      seen.set(key, nowMs + DEDUPE_TTL_MS);
      return false;
    },
    size: (): number => seen.size,
  };
}

/**
 * Build a Slack ingress dedupe key. The key MUST be stable across the
 * original delivery and all of its retries — otherwise the original is
 * processed once, then the first retry (`X-Slack-Retry-Num: 1`) collides
 * with nothing in the cache and side-effecting handlers run twice.
 *
 *   - Events API: `event_id` is Slack's own stable retry identifier.
 *   - Slash commands / interactive payloads: there is no per-event ID, so
 *     we hash the SIGNED body. Slack signs the original timestamp and body
 *     verbatim on every retry, so the hash is identical across retries.
 *     Legitimate fresh invocations carry unique nonces (`trigger_id`,
 *     `action_ts`) inside the signed body, so two real user clicks produce
 *     different hashes and are never collapsed.
 */
function dedupeKeyFor(body: string, parsed: Record<string, unknown> | undefined): string {
  const eventId = parsed?.event_id;
  if (typeof eventId === "string" && eventId.length > 0) return `event:${eventId}`;
  return `body:${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
}

/**
 * Capabilities reflect what we ACTUALLY render natively, not what Slack
 * the platform supports. We currently flatten everything to text via
 * `chat.postMessage` — Block Kit, file uploads, and interactive components
 * are not implemented yet. Marking these `false` means `@koi/channel-base`'s
 * `renderBlocks()` will downgrade upstream blocks to text BEFORE they reach
 * us, so callers don't believe attachments survive the round trip.
 */
const SLACK_CAPABILITIES = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

export type SlackReplyToMode = "off" | "first" | "all";

export type SlackDeployment =
  | { readonly mode: "socket"; readonly appToken: string }
  | { readonly mode: "http"; readonly signingSecret: string };

export interface SlackFeatures {
  readonly threads?: boolean;
  readonly slashCommands?: boolean;
  readonly files?: boolean;
  readonly replyToMode?: SlackReplyToMode;
}

interface ResolvedFeatures {
  readonly threads: boolean;
  readonly slashCommands: boolean;
  readonly files: boolean;
  readonly replyToMode: SlackReplyToMode;
}

function resolveFeatures(f?: SlackFeatures): ResolvedFeatures {
  return {
    threads: f?.threads ?? true,
    slashCommands: f?.slashCommands ?? true,
    files: f?.files ?? true,
    replyToMode: f?.replyToMode ?? "all",
  };
}

/** Test-injectable Slack client doubles. */
export interface SlackClients {
  readonly webClient: WebClientLike;
  readonly socketClient?: SocketModeClientLike;
}

export interface WebClientLike {
  readonly chat: {
    readonly postMessage: (args: Record<string, unknown>) => Promise<unknown>;
  };
  /** Optional: used to resolve the bot's own user ID at connect time. */
  readonly auth?: {
    readonly test: () => Promise<{ readonly user_id?: string }>;
  };
}

export interface SocketModeClientLike {
  readonly start: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly on: (event: string, listener: (payload: unknown) => void) => void;
  readonly removeAllListeners: () => void;
}

export interface SlackChannelConfig {
  readonly botToken: string;
  readonly deployment: SlackDeployment;
  readonly features?: SlackFeatures;
  readonly botUserId?: string;
  /**
   * Default Slack channel ID (e.g. `"C123"`) used when an outbound
   * `OutboundMessage` has no `threadId`. Required for any proactive send
   * (status update, scheduled message) that is not a reply. If both are
   * absent, `send()` throws so we never produce a `channel: ""` API call.
   */
  readonly defaultChannel?: string;
  /** Test-only: inject Slack client doubles to avoid real network/SDK. */
  readonly clients?: SlackClients;
}

export interface SlackChannelAdapter extends ChannelAdapter {
  /** Socket Mode only: forward an SDK-verified payload through dispatch. */
  readonly handleEvent?: (payload: unknown) => void;
  /** HTTP mode only: signature-verifies and dispatches a raw Slack request. */
  readonly handleHttpRequest?: (request: Request) => Promise<Response>;
}

function blocksToText(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.kind === "text") parts.push(b.text);
    else if (b.kind === "image") parts.push(`[image] ${b.url}`);
    else if (b.kind === "file") parts.push(`[file] ${b.url}`);
    else if (b.kind === "button") parts.push(`[${b.label}]`);
  }
  return parts.join("\n");
}

function applyReplyToMode(message: OutboundMessage, mode: SlackReplyToMode): OutboundMessage {
  if (mode === "all" || message.threadId === undefined) return message;
  if (mode === "off") {
    const i = message.threadId.indexOf(":");
    return i === -1 ? message : { ...message, threadId: message.threadId.slice(0, i) };
  }
  // "first": v1 simplification — without server-side first-message lookup, fall through to "all"
  return message;
}

/**
 * Resolve the Slack `channel` + optional `thread_ts` for an outbound message.
 *
 * Threading convention: `threadId === "C123"` posts to the channel root,
 * `threadId === "C123:1700.0"` posts in the thread `1700.0` of `C123`.
 * If the outbound message has no `threadId`, the caller MUST have configured
 * `defaultChannel` so proactive sends have a destination — otherwise we throw
 * rather than send `channel: ""` to Slack and fail with a confusing API error.
 */
function postArgsFor(
  message: OutboundMessage,
  defaultChannel: string | undefined,
): Record<string, unknown> {
  const threadId = message.threadId ?? defaultChannel;
  if (threadId === undefined || threadId === "") {
    throw new Error(
      "[channel-slack] cannot send: OutboundMessage has no threadId and no defaultChannel is configured. " +
        "Either set message.threadId to a Slack channel ID (e.g. 'C123') or pass `defaultChannel` to createSlackChannel.",
    );
  }
  const colon = threadId.indexOf(":");
  const channel = colon === -1 ? threadId : threadId.slice(0, colon);
  const thread_ts = colon === -1 ? undefined : threadId.slice(colon + 1);
  const args: Record<string, unknown> = { channel, text: blocksToText(message.content) };
  if (thread_ts !== undefined) args.thread_ts = thread_ts;
  return args;
}

export function createSlackChannel(config: SlackChannelConfig): SlackChannelAdapter {
  const features = resolveFeatures(config.features);
  // let requires justification: clients populated either from config (tests) or
  // from lazy SDK load during platformConnect()
  let webClient: WebClientLike | undefined = config.clients?.webClient;
  let socketClient: SocketModeClientLike | undefined =
    config.deployment.mode === "socket" ? config.clients?.socketClient : undefined;
  // let requires justification: resolved live in platformConnect via auth.test;
  // the normalizer reads through a getter so updates take effect for any
  // event arriving after connect, regardless of which path created the client.
  let botUserId = config.botUserId;
  // let requires justification: stores platform event handler for direct dispatch
  let dispatch: ((event: SlackEvent) => void) | undefined;
  // let requires justification: counts active onMessage subscribers so HTTP/Socket
  // ingress can refuse to ack when there's nobody to deliver to (no silent drop).
  let handlerCount = 0;
  // Per-adapter ingress dedupe — survives across requests but is bounded.
  const dedupe = createIngressDedupe();

  const base = createChannelAdapter<SlackEvent>({
    name: "slack",
    capabilities: SLACK_CAPABILITIES,

    platformConnect: async () => {
      if (webClient === undefined) {
        webClient = await createWebClient(config.botToken);
      }
      if (config.deployment.mode === "socket" && socketClient === undefined) {
        socketClient = await createSocketClient(config.deployment.appToken);
      }
      // Resolve bot user id BEFORE listening so self-message filtering works
      // from the very first event. Self-messages would otherwise be dispatched
      // back into the agent loop and cause feedback spirals.
      if (botUserId === undefined) {
        // null = SDK has no `auth.test` surface (test doubles) — fall back
        // to the placeholder so unit tests still work. Real failures bubble
        // up and fail connect() per the resolveBotUserId contract.
        botUserId = (await resolveBotUserId(webClient)) ?? "unknown";
      }
      // Wire Socket Mode listeners BEFORE start() so we don't miss the first
      // event. Listeners dispatch through a closure-captured `dispatch` so they
      // remain wired even if onPlatformEvent() registers later in the lifecycle.
      //
      // channel-base orders `platformConnect()` BEFORE `onPlatformEvent()`, so
      // `dispatch` is undefined while the Socket Mode client starts. We fail
      // closed during that window: if dispatch isn't installed yet, the guard
      // reports "no handler", which refuses to ack and lets Slack redeliver
      // once we're ready. Without this, a startup event would pass through
      // `dispatch?.(event)` as a no-op AND get acked — silent loss.
      if (socketClient !== undefined) {
        wireSocketModeEvents(
          socketClient,
          (event) => dispatch?.(event),
          features,
          () => (dispatch === undefined ? 0 : handlerCount),
          (key) => dedupe.observe(key, Date.now()),
        );
        await socketClient.start();
      }
    },

    platformDisconnect: async () => {
      if (socketClient !== undefined) {
        socketClient.removeAllListeners();
        await socketClient.disconnect();
      }
    },

    platformSend: async (message) => {
      if (webClient === undefined) {
        throw new Error("[channel-slack] cannot send: not connected");
      }
      const adjusted = applyReplyToMode(message, features.replyToMode);
      await webClient.chat.postMessage(postArgsFor(adjusted, config.defaultChannel));
    },

    onPlatformEvent: (handler) => {
      dispatch = handler;
      return () => {
        dispatch = undefined;
      };
    },

    // Normalizer reads botUserId live so messages received after auth.test
    // resolution use the real ID and self-authored events are dropped.
    normalize: createNormalizer(() => botUserId ?? "unknown"),
  });

  function dispatchHttpEvent(payload: unknown): void {
    if (dispatch === undefined || typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.type === "event_callback") {
      const inner = p.event as Record<string, unknown> | undefined;
      const innerType = inner?.type;
      if (innerType === "app_mention") {
        dispatch({ kind: "app_mention", event: inner as never });
      } else if (innerType === "message") {
        dispatch({ kind: "message", event: inner as never });
      }
    }
  }

  /**
   * Parse a form-encoded slash-command body and route to the slash dispatcher.
   * Slack POSTs slash commands as `application/x-www-form-urlencoded`, NOT JSON.
   */
  function dispatchSlashCommand(body: string): void {
    if (dispatch === undefined || !features.slashCommands) return;
    const params = new URLSearchParams(body);
    const command = params.get("command");
    if (command === null) return;
    dispatch({
      kind: "slash_command",
      command: {
        command,
        text: params.get("text") ?? "",
        user_id: params.get("user_id") ?? "",
        channel_id: params.get("channel_id") ?? "",
        trigger_id: params.get("trigger_id") ?? "",
        response_url: params.get("response_url") ?? "",
      },
    });
  }

  /**
   * Parse a form-encoded interactive payload (`payload=<json>`) and route
   * each block_action to the dispatcher. Slack POSTs button clicks, modal
   * submissions, etc. via this single endpoint.
   */
  function dispatchInteractive(body: string): void {
    if (dispatch === undefined || !features.slashCommands) return;
    const raw = new URLSearchParams(body).get("payload");
    if (raw === null) return;
    // let requires justification: payload JSON shape narrowed by `type` field below
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (payload.type !== "block_actions") return;
    const actions = (payload.actions ?? []) as readonly Record<string, unknown>[];
    for (const action of actions) {
      dispatch({
        kind: "block_action",
        action: {
          ...action,
          user: payload.user as { readonly id: string },
          channel: payload.channel as { readonly id: string } | undefined,
          message: payload.message as
            | { readonly ts: string; readonly thread_ts?: string }
            | undefined,
        } as never,
      });
    }
  }

  if (config.deployment.mode === "http") {
    const { signingSecret } = config.deployment;
    const handleHttpRequest = async (request: Request): Promise<Response> => {
      const result = await verifySlackRequest(signingSecret, request);
      if (!result.ok) {
        if (result.tooLarge === true) {
          return new Response("Payload Too Large", { status: 413 });
        }
        return new Response("Unauthorized", { status: 401 });
      }
      const ct = request.headers.get("content-type") ?? "";
      const isForm = ct.startsWith("application/x-www-form-urlencoded");

      // JSON path needs to handle url_verification handshake BEFORE the
      // handler-count gate — Slack issues this once at app install time and
      // there's no agent listener to consult.
      // let requires justification: parsed JSON body, narrowed below
      let parsed: Record<string, unknown> | undefined;
      if (!isForm) {
        try {
          parsed = JSON.parse(result.body) as Record<string, unknown>;
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
          return new Response(parsed.challenge, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
      }

      // No handler attached → tell Slack to retry instead of acking and
      // silently dropping. Slack will redeliver per its retry policy.
      if (handlerCount === 0) {
        return new Response("Service Unavailable", { status: 503 });
      }

      // Dedupe BEFORE dispatch so retried payloads are ack'd as no-ops
      // rather than processed twice. The key is stable across the original
      // delivery and all of its retries (event_id, or signed-body hash for
      // slash/interactive); legitimate fresh invocations carry unique
      // nonces in the signed body so they never collide.
      if (dedupe.observe(dedupeKeyFor(result.body, parsed), Date.now())) {
        return new Response("OK", { status: 200 });
      }

      if (isForm) {
        if (result.body.startsWith("payload=")) {
          dispatchInteractive(result.body);
        } else {
          dispatchSlashCommand(result.body);
        }
        return new Response("", { status: 200 });
      }

      dispatchHttpEvent(parsed);
      return new Response("OK", { status: 200 });
    };
    return wrapWithHandlerCounter(
      { ...base, handleHttpRequest },
      () => handlerCount,
      (n) => {
        handlerCount = n;
      },
      base.onMessage,
    );
  }

  return wrapWithHandlerCounter(
    { ...base, handleEvent: dispatchHttpEvent },
    () => handlerCount,
    (n) => {
      handlerCount = n;
    },
    base.onMessage,
  );
}

/**
 * Wrap an adapter so each `onMessage` subscription bumps a tracked counter.
 * Used by HTTP/Socket ingress paths to refuse acks when there's nobody to
 * deliver to (no silent drop).
 */
function wrapWithHandlerCounter<A extends ChannelAdapter>(
  adapter: A,
  getCount: () => number,
  setCount: (n: number) => void,
  baseOnMessage: A["onMessage"],
): A {
  return {
    ...adapter,
    onMessage: (handler) => {
      setCount(getCount() + 1);
      const unsub = baseOnMessage(handler);
      // let requires justification: each subscription tracks its own active flag
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        setCount(Math.max(0, getCount() - 1));
        unsub();
      };
    },
  };
}

function wireSocketModeEvents(
  client: SocketModeClientLike,
  handler: (event: SlackEvent) => void,
  features: ResolvedFeatures,
  getHandlerCount: () => number,
  /**
   * Returns true if this delivery has already been processed (within the
   * replay window). Slack's Socket Mode redelivers unacked envelopes, so
   * application events MUST be deduped before dispatch — otherwise reconnect
   * scenarios cause double execution of side-effecting handlers.
   */
  observeDelivery: (key: string) => boolean,
): void {
  /**
   * Build a Socket Mode dedupe key. `envelope_id` is set on every Socket
   * Mode delivery. Falls back to a content hash so events from older SDKs
   * or non-standard test doubles still get a stable key.
   */
  function deliveryKey(wrapper: Record<string, unknown>): string {
    const envelopeId = wrapper.envelope_id;
    if (typeof envelopeId === "string" && envelopeId.length > 0) return `sm-env:${envelopeId}`;
    // strip the SDK-supplied `ack` callback so the hash is reproducible
    const { ack: _ack, ...rest } = wrapper;
    void _ack;
    return `sm-hash:${createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 32)}`;
  }

  // No-handler guard for application events. We do NOT ack — Slack will retry
  // and we'll process on the next delivery once a consumer is attached. This
  // mirrors the HTTP 503 behavior so events are never acked-and-dropped during
  // startup or handler churn.
  //
  // Interactive callbacks are exempt: they are user-driven and have a 3-second
  // ack deadline, so we always ack to avoid the user-facing "this didn't work"
  // error in Slack's UI even when no consumer is registered.
  const guarded = (fn: (wrapper: Record<string, unknown>) => void): ((raw: unknown) => void) => {
    return (raw: unknown) => {
      if (getHandlerCount() === 0) return;
      const wrapper = raw as Record<string, unknown>;
      // Dedupe BEFORE dispatch. Retried deliveries are ack'd-as-no-op so
      // Slack stops looping, but the handler runs at most once per envelope.
      if (observeDelivery(deliveryKey(wrapper))) {
        ack(wrapper);
        return;
      }
      fn(wrapper);
      ack(wrapper);
    };
  };

  client.on(
    "message",
    guarded((wrapper) => {
      const inner = (wrapper.event ?? wrapper) as Record<string, unknown>;
      handler({ kind: "message", event: inner as never });
    }),
  );
  client.on(
    "app_mention",
    guarded((wrapper) => {
      const inner = (wrapper.event ?? wrapper) as Record<string, unknown>;
      handler({ kind: "app_mention", event: inner as never });
    }),
  );
  if (features.slashCommands) {
    client.on(
      "slash_commands",
      guarded((wrapper) => {
        handler({ kind: "slash_command", command: wrapper as never });
      }),
    );
    // Interactive: handler-count check BEFORE ack so a button click is never
    // ack'd-and-dropped during startup or handler churn. Without a consumer
    // we must not ack — Slack already received the click; ack'ing here would
    // permanently consume it with no retry path. Letting the 3s deadline
    // elapse surfaces a user-visible "didn't work" error in Slack, which is
    // the correct signal that the action was not delivered.
    client.on("interactive", (raw: unknown) => {
      const wrapper = raw as Record<string, unknown>;
      if (getHandlerCount() === 0) return;
      ack(wrapper);
      // Retried button click → already deduped from a previous delivery.
      if (observeDelivery(deliveryKey(wrapper))) return;
      const payload = (wrapper.payload ?? wrapper) as Record<string, unknown>;
      if (payload.type !== "block_actions") return;
      const actions = (payload.actions ?? []) as readonly Record<string, unknown>[];
      for (const action of actions) {
        handler({
          kind: "block_action",
          action: {
            ...action,
            user: payload.user as { readonly id: string },
            channel: payload.channel as { readonly id: string } | undefined,
            message: payload.message as
              | { readonly ts: string; readonly thread_ts?: string }
              | undefined,
          } as never,
        });
      }
    });
  }
}

function ack(wrapper: Record<string, unknown>): void {
  const fn = wrapper.ack;
  if (typeof fn === "function") {
    (fn as () => void)();
  }
}

/**
 * Resolve the bot's own user ID via Slack's `auth.test` so self-authored
 * events can be filtered out by the normalizer. Returns `null` only when the
 * SDK surface does not expose `auth.test` at all (test doubles); in that
 * case the caller falls back to the `"unknown"` placeholder.
 *
 * For real Slack clients we MUST get a real user_id — failing open with a
 * placeholder lets the bot's own messages re-enter the agent loop and
 * cause feedback spirals. Network failures and missing `user_id` therefore
 * throw, which fails `connect()` so the host can retry.
 */
async function resolveBotUserId(webClient: WebClientLike): Promise<string | null> {
  if (webClient.auth?.test === undefined) return null;
  const result = await webClient.auth.test();
  if (typeof result.user_id !== "string" || result.user_id.length === 0) {
    throw new Error(
      "[channel-slack] auth.test returned no user_id — refusing to connect with an " +
        "unknown bot identity (self-authored messages would loop back into the agent).",
    );
  }
  return result.user_id;
}

async function createWebClient(token: string): Promise<WebClientLike> {
  const mod = (await import("@slack/web-api")) as unknown as {
    readonly WebClient: new (token: string) => WebClientLike;
  };
  return new mod.WebClient(token);
}

async function createSocketClient(appToken: string): Promise<SocketModeClientLike> {
  const mod = (await import("@slack/socket-mode")) as unknown as {
    readonly SocketModeClient: new (opts: { readonly appToken: string }) => SocketModeClientLike;
  };
  return new mod.SocketModeClient({ appToken });
}
