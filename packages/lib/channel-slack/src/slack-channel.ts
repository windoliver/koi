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
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  OutboundMessage,
} from "@koi/core";
import { createNormalizer, type SlackEvent } from "./normalize.js";
import { verifySlackRequest } from "./verify-signature.js";

/** Replay window in `verify-signature.ts` is 5 minutes — match it here. */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
/**
 * High-water cap to prevent OOM if traffic somehow exceeds 50k unique
 * deliveries inside a single 5-minute replay window. At that point we evict
 * oldest-first; correctness degrades gracefully (a duplicate dispatch becomes
 * possible) rather than crashing the process. 50k unique deliveries / 5min =
 * ~167 events/sec sustained, far above realistic Slack workspace throughput.
 */
const DEDUPE_HIGH_WATER = 50_000;

/**
 * In-memory dedupe with TTL eviction and a high-water backstop. Slack retries
 * unacked deliveries via `Retry-Num`, and replay attacks within the
 * verification window are still possible after signature checking, so every
 * accepted signed request must pass through this gate before dispatch.
 *
 * Eviction order:
 *   1. Sweep expired entries on every `observe()`. Map insertion order matches
 *      expiry order (TTL is fixed), so this amortizes O(1).
 *   2. If the live set still exceeds DEDUPE_HIGH_WATER, evict the oldest
 *      entry. This is the safety valve against OOM under abnormal bursts.
 */
function createIngressDedupe(): {
  /** True if this key has already been committed within the live window. */
  readonly has: (key: string, nowMs: number) => boolean;
  /** Commit the key (only call AFTER the delivery has been handed to a handler). */
  readonly commit: (key: string, nowMs: number) => void;
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
    has: (key: string, nowMs: number): boolean => {
      sweepExpired(nowMs);
      return seen.has(key);
    },
    commit: (key: string, nowMs: number): void => {
      sweepExpired(nowMs);
      while (seen.size >= DEDUPE_HIGH_WATER) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seen.set(key, nowMs + DEDUPE_TTL_MS);
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

/**
 * Outbound threading behavior:
 *   - `"all"`: every threaded outbound message is posted in-thread (default).
 *   - `"off"`: strip the thread, posting every reply at channel root.
 * Note: `"first"` (in-thread only for the first reply) is intentionally
 * NOT supported — implementing it requires server-side first-message
 * lookup we don't have. Selecting it would silently degrade to `"all"`,
 * so the constructor rejects it instead.
 */
export type SlackReplyToMode = "off" | "all";

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
  // Reject the legacy `"first"` value at construction. Earlier code
  // accepted it then silently fell through to `"all"`, so callers got
  // behavior they did not select. The type now excludes it; this guard
  // catches host code that bypasses the type (e.g. JSON config).
  if ((f?.replyToMode as string) === "first") {
    throw new Error(
      '[channel-slack] replyToMode: "first" is not supported. Use "all" or "off". ' +
        'Selecting "first" requires server-side first-message lookup that this adapter does not provide.',
    );
  }
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
  /**
   * Visibility hook for handler failures during async dispatch. Slack must
   * be ack'd within seconds, so handlers run asynchronously after ack —
   * this means a handler that throws AFTER ack is a permanent message
   * loss as far as Slack is concerned (no platform-level retry). Hosts
   * that need durability MUST use this hook to enqueue the failed
   * `InboundMessage` to their own DLQ / durable storage. Without it,
   * downstream failures are silent.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /**
   * Observability hook for valid-but-unsupported Slack callbacks
   * (interactive `payload.type` values this adapter doesn't surface
   * — view_submission, view_closed, shortcut, etc. — and unknown
   * `event_callback` subtypes). The HTTP path 200-acks them to keep
   * Slack's user-facing modal contract intact, but without this hook
   * the operator has no way to see that user actions are being
   * dropped. Hosts MUST wire this to logs/metrics in production.
   *
   * Deliberately includes ONLY the kind+type discriminator. Raw
   * payload bodies are intentionally NOT exposed — they routinely
   * contain user message text, identifiers, and callback URLs which
   * should not be funneled into general logging surfaces. Hosts that
   * need raw payloads for diagnostics should use a dedicated
   * middleware that handles them with appropriate redaction.
   *
   * Errors thrown from this hook are caught and ignored to protect
   * Slack's ack-timing contract.
   */
  readonly onUnsupportedEvent?: (info: {
    readonly kind: "interactive" | "event_callback";
    readonly type: string;
  }) => void | Promise<void>;
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

type UnsupportedEventInfo = {
  readonly kind: "interactive" | "event_callback";
  readonly type: string;
};

// Containment wrapper: hosts must not be able to break Slack's ack
// timing through this hook. Catches sync throws AND async rejections —
// `Promise.resolve(...)` normalizes both `void` and `Promise<void>`
// returns, and the `.catch()` swallows rejections so an `async` hook
// that throws cannot produce an unhandled promise rejection on the ack
// path.
function fireUnsupportedEvent(
  hook: (info: UnsupportedEventInfo) => void | Promise<void>,
  info: UnsupportedEventInfo,
): void {
  try {
    Promise.resolve(hook(info)).catch(() => {
      // best-effort observability; async rejections never escape
    });
  } catch {
    // sync throw also swallowed
  }
}

// Pure classifier — runs BEFORE the handler-readiness gate so we can
// 200-ack unsupported interactive callbacks during startup churn
// without breaking Slack's 3s modal contract. Mirrors the parsing in
// dispatchInteractive but emits no events.
function dispatchInteractiveClassify(body: string): "dispatchable" | "ack-only" | "malformed" {
  const raw = new URLSearchParams(body).get("payload");
  if (raw === null) return "malformed";
  let payload: { type?: unknown; actions?: unknown };
  try {
    payload = JSON.parse(raw) as { type?: unknown; actions?: unknown };
  } catch {
    return "malformed";
  }
  if (payload.type !== "block_actions") return "ack-only";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (actions.length === 0) return "ack-only";
  return "dispatchable";
}

function extractInteractiveType(body: string): string {
  const raw = new URLSearchParams(body).get("payload");
  if (raw === null) return "unknown";
  try {
    const p = JSON.parse(raw) as { type?: unknown };
    return typeof p.type === "string" ? p.type : "unknown";
  } catch {
    return "unknown";
  }
}

function applyReplyToMode(message: OutboundMessage, mode: SlackReplyToMode): OutboundMessage {
  if (mode === "all" || message.threadId === undefined) return message;
  // mode === "off": strip thread, post at channel root
  const i = message.threadId.indexOf(":");
  return i === -1 ? message : { ...message, threadId: message.threadId.slice(0, i) };
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
          (key) => dedupe.has(key, Date.now()),
          (key) => dedupe.commit(key, Date.now()),
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

    // Forward handler failures so hosts can DLQ. Slack will not retry once
    // we've ack'd, so this hook is the ONLY visibility into post-ack
    // handler failures — silent loss otherwise.
    ...(config.onHandlerError !== undefined
      ? {
          onHandlerError: (err: unknown, message: InboundMessage) => {
            config.onHandlerError?.(err, message);
          },
        }
      : {}),
  });

  function dispatchHttpEvent(payload: unknown): boolean {
    if (dispatch === undefined || typeof payload !== "object" || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (p.type !== "event_callback") return false;
    const inner = p.event as Record<string, unknown> | undefined;
    const innerType = inner?.type;
    if (innerType === "app_mention") {
      dispatch({ kind: "app_mention", event: inner as never });
      return true;
    }
    if (innerType === "message") {
      dispatch({ kind: "message", event: inner as never });
      return true;
    }
    return false;
  }

  /**
   * Parse a form-encoded slash-command body and route to the slash dispatcher.
   * Slack POSTs slash commands as `application/x-www-form-urlencoded`, NOT JSON.
   */
  function dispatchSlashCommand(body: string): boolean {
    if (dispatch === undefined || !features.slashCommands) return false;
    const params = new URLSearchParams(body);
    const command = params.get("command");
    if (command === null) return false;
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
    return true;
  }

  /**
   * Parse a form-encoded interactive payload (`payload=<json>`) and route
   * each block_action to the dispatcher. Slack POSTs button clicks, modal
   * submissions, etc. via this single endpoint.
   */
  type InteractiveResult = "dispatched" | "ack-only" | "malformed";

  function dispatchInteractive(body: string): InteractiveResult {
    const raw = new URLSearchParams(body).get("payload");
    if (raw === null) return "malformed";
    // let requires justification: payload JSON shape narrowed by `type` field below
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "malformed";
    }
    // Valid Slack interactive callback whose type we don't surface (e.g.
    // view_submission, view_closed, shortcut). Slack expects a 200 within
    // 3s or the user sees an error modal; ack without dispatching.
    if (payload.type !== "block_actions") return "ack-only";
    if (dispatch === undefined || !features.slashCommands) return "ack-only";
    const actions = (payload.actions ?? []) as readonly Record<string, unknown>[];
    if (actions.length === 0) return "ack-only";
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
    return "dispatched";
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

      // Already-committed retry → 200 ack. Idempotency takes precedence
      // over presence: even during listener churn, a retry of a
      // previously-dispatched delivery must always 200 or Slack keeps
      // redelivering and once a listener returns the side effects run
      // a second time. Key is stable across original + all retries
      // (event_id, or signed-body hash for slash/interactive);
      // legitimate fresh invocations carry unique nonces.
      const dedupeKey = dedupeKeyFor(result.body, parsed);
      const now = Date.now();
      if (dedupe.has(dedupeKey, now)) {
        return new Response("OK", { status: 200 });
      }

      // Interactive ack-only classification runs BEFORE the readiness
      // gate. Valid-but-unsupported interactive callbacks
      // (view_submission, shortcut, etc) MUST get a 2xx within 3s
      // regardless of handler/dispatch state — otherwise Slack shows
      // the end-user an error modal during startup or reconnect
      // churn. The hook still fires so operators see the drop.
      if (isForm && result.body.startsWith("payload=")) {
        const r = dispatchInteractiveClassify(result.body);
        if (r === "malformed") return new Response("Malformed payload", { status: 400 });
        if (r === "ack-only") {
          if (config.onUnsupportedEvent !== undefined) {
            fireUnsupportedEvent(config.onUnsupportedEvent, {
              kind: "interactive",
              type: extractInteractiveType(result.body),
            });
          }
          return new Response("", { status: 200 });
        }
        // r === "dispatchable" — fall through to the readiness gate
        // and dispatch path below.
      }

      // Fresh delivery + not ready → 503, do NOT commit dedupe. "Ready"
      // means BOTH a handler is registered AND the platform dispatch
      // path is installed. handlerCount can rise via onMessage() before
      // connect() / onPlatformEvent(), so checking it alone isn't enough
      // — without `dispatch` the handlers below silently no-op and we'd
      // 200+commit despite delivering nothing. Slack retries until both
      // sides are ready.
      if (handlerCount === 0 || dispatch === undefined) {
        return new Response("Service Unavailable", { status: 503 });
      }

      if (isForm) {
        if (result.body.startsWith("payload=")) {
          // Already classified as dispatchable above; emit it.
          dispatchInteractive(result.body);
          dedupe.commit(dedupeKey, now);
          return new Response("", { status: 200 });
        }
        if (!dispatchSlashCommand(result.body)) {
          return new Response("Unsupported slash command", { status: 400 });
        }
        dedupe.commit(dedupeKey, now);
        return new Response("", { status: 200 });
      }

      const dispatched = dispatchHttpEvent(parsed);
      if (!dispatched) {
        // Unsupported event_callback subtype (e.g. operator subscribed
        // to reaction_added). Fail loud — Slack's app dashboard
        // surfaces 4xx delivery failures — and ALSO fire the
        // observability hook so the host learns about it directly.
        if (config.onUnsupportedEvent !== undefined) {
          const inner = (parsed as { event?: { type?: string } }).event;
          fireUnsupportedEvent(config.onUnsupportedEvent, {
            kind: "event_callback",
            type: inner?.type ?? "unknown",
          });
        }
        return new Response("Unsupported event type", { status: 400 });
      }
      // Commit AFTER dispatch — the delivery is now considered handled.
      dedupe.commit(dedupeKey, now);
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
   * `hasDelivery`: true if this key was already committed (a previous
   * delivery was dispatched). `commitDelivery`: record the key now —
   * caller MUST only call this after the delivery is handed off to a
   * handler. Splitting check from commit prevents poisoning the cache
   * with deliveries that arrived during a handler-less window.
   */
  hasDelivery: (key: string) => boolean,
  commitDelivery: (key: string) => void,
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
      const wrapper = raw as Record<string, unknown>;
      const key = deliveryKey(wrapper);
      // Already-committed retry → ack-as-no-op. Idempotency takes
      // precedence over presence: even during listener churn, a retry
      // of a previously-dispatched envelope must always be ack'd or
      // Slack keeps redelivering and side effects can run twice.
      if (hasDelivery(key)) {
        ack(wrapper);
        return;
      }
      // Fresh delivery + no handler → don't ack and don't commit. Slack
      // retries; the cache stays empty so the retry CAN dispatch once a
      // consumer is attached. Committing here would poison the cache and
      // turn handler-less arrivals into permanent loss.
      if (getHandlerCount() === 0) return;
      fn(wrapper);
      // Commit only AFTER successful dispatch. Then ack so Slack stops.
      commitDelivery(key);
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
        // Slack Socket Mode SDK delivers slash commands as { ack, body, ... }.
        // The `body` carries the actual command/user_id/channel_id fields;
        // forwarding the whole wrapper would emit a malformed inbound message.
        const command = (wrapper.body ?? wrapper) as Record<string, unknown>;
        handler({ kind: "slash_command", command: command as never });
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
      const key = deliveryKey(wrapper);
      // Already-committed retry → ack as no-op, do not redispatch.
      if (hasDelivery(key)) {
        ack(wrapper);
        return;
      }
      // Fresh delivery + no handler → don't ack, don't commit. Slack
      // already received the click; ack'ing here would permanently
      // consume it with no retry path. Letting the 3s deadline elapse
      // surfaces a user-visible "didn't work" error in Slack.
      if (getHandlerCount() === 0) return;
      ack(wrapper);
      // SDK wrapper carries the user payload at `body` (canonical) or
      // `payload` (older shapes / test doubles). Either way we want the
      // inner `block_actions` payload, not the wrapper.
      const payload = (wrapper.body ?? wrapper.payload ?? wrapper) as Record<string, unknown>;
      if (payload.type !== "block_actions") {
        // Unsupported payload type — committed (we ack'd) but no dispatch.
        commitDelivery(key);
        return;
      }
      const actions = (payload.actions ?? []) as readonly Record<string, unknown>[];
      // Commit BEFORE dispatch loop so a re-entrant delivery (rare) cannot
      // fire the actions twice. Once we ack, the delivery is owned by us.
      commitDelivery(key);
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
