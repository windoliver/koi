/**
 * @koi/channel-slack — Slack channel adapter.
 *
 * Creates a ChannelAdapter for Slack bots using @slack/web-api and
 * @slack/socket-mode. Supports Socket Mode (WebSocket) and HTTP Events API.
 *
 * Usage:
 *   const adapter = createSlackChannel({
 *     botToken: "xoxb-...",
 *     deployment: { mode: "socket", appToken: "xapp-..." },
 *   });
 *   await adapter.connect();
 *
 * threadId convention:
 * - Channels: "channelId"
 * - Threads: "channelId:threadTs"
 */

import { createChannelAdapter, createMediaFallback } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  OutboundMessage,
} from "@koi/core";
import type { SlackChannelConfig } from "./config.js";
import { resolveFeatures } from "./config.js";
import type { SlackEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";
import type { SlackWebApi } from "./platform-send.js";
import { slackSend } from "./platform-send.js";
import { verifySlackRequest } from "./verify-signature.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const SLACK_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** ChannelAdapter extended with Slack-specific methods. */
export interface SlackChannelAdapter extends ChannelAdapter {
  /**
   * Handles a pre-verified Slack event payload.
   * Only available in socket mode (where the Slack SDK handles verification).
   * In HTTP mode this is deliberately NOT exposed — use handleHttpRequest instead.
   */
  readonly handleEvent?: (payload: unknown) => void;
  /** Handles a raw Slack HTTP request with signature verification (HTTP mode only). */
  readonly handleHttpRequest?: (request: Request) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// Types for injected or real clients
// ---------------------------------------------------------------------------

interface SocketModeClientLike {
  readonly start: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly on: (event: string, listener: (...args: readonly unknown[]) => void) => void;
  readonly removeAllListeners: () => void;
}

interface WebClientLike {
  readonly chat: { readonly postMessage: (args: Record<string, unknown>) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Slack ChannelAdapter.
 *
 * @param config - Bot token, deployment mode, and optional hooks.
 * @returns A SlackChannelAdapter satisfying the @koi/core ChannelAdapter contract.
 */
export function createSlackChannel(config: SlackChannelConfig): SlackChannelAdapter {
  const features = resolveFeatures(config.features);

  // Create or use injected clients
  const webClient = (config._webClient ?? createWebClient(config.botToken)) as WebClientLike;
  const socketClient =
    config.deployment.mode === "socket"
      ? ((config._socketClient ??
          createSocketClient(config.deployment.appToken)) as SocketModeClientLike)
      : undefined;

  const api: SlackWebApi = {
    postMessage: async (args: Record<string, unknown>) => webClient.chat.postMessage(args),
  };

  // let justified: botUserId determined after auth.test response
  let botUserId = "unknown";

  // let justified: stores platform event handler for dispatch
  let eventHandler: ((event: SlackEvent) => void) | undefined;

  const platformSendStatus = async (status: ChannelStatus): Promise<void> => {
    if (status.kind !== "processing" || status.messageRef === undefined) {
      return;
    }
    // Slack doesn't have a native typing indicator for bots.
    // We skip this silently — no API call needed.
  };

  const base = createChannelAdapter<SlackEvent>({
    name: "slack",
    capabilities: SLACK_CAPABILITIES,

    platformConnect: async () => {
      if (socketClient !== undefined) {
        await socketClient.start();
      }
      // Resolve bot user ID via auth.test
      try {
        const result = (await webClient.chat.postMessage({
          channel: "",
          text: "",
          _authTest: true,
        })) as { readonly user_id?: string } | undefined;
        if (result?.user_id !== undefined) {
          botUserId = result.user_id;
        }
      } catch {
        // auth.test is best-effort; botUserId stays "unknown"
      }
    },

    platformDisconnect: async () => {
      if (socketClient !== undefined) {
        socketClient.removeAllListeners();
        await socketClient.disconnect();
      }
    },

    platformSend: createMediaFallback({
      send: async (message: OutboundMessage) => {
        // Apply replyToMode: strip threadTs from threadId when mode says so
        const adjusted = applyReplyToMode(message, features.replyToMode);
        await slackSend(api, adjusted);
      },
      ...(config.mediaMaxMb !== undefined ? { mediaMaxMb: config.mediaMaxMb } : {}),
    }),

    onPlatformEvent: (handler) => {
      eventHandler = handler;

      if (socketClient !== undefined) {
        // Socket Mode events
        if (features.threads || features.files) {
          socketClient.on("message", (rawEvent: unknown) => {
            const event = rawEvent as Record<string, unknown>;
            const inner = (event.event ?? event) as Record<string, unknown>;
            handler({
              kind: "message",
              event: inner as unknown as import("./normalize.js").SlackMessageEvent,
            });
            acknowledgeEvent(event);
          });
        }

        socketClient.on("app_mention", (rawEvent: unknown) => {
          const event = rawEvent as Record<string, unknown>;
          const inner = (event.event ?? event) as Record<string, unknown>;
          handler({
            kind: "app_mention",
            event: inner as unknown as import("./normalize.js").SlackAppMentionEvent,
          });
          acknowledgeEvent(event);
        });

        if (features.slashCommands) {
          socketClient.on("slash_commands", (rawEvent: unknown) => {
            const event = rawEvent as Record<string, unknown>;
            handler({
              kind: "slash_command",
              command: event as unknown as import("./normalize.js").SlackSlashCommand,
            });
            acknowledgeEvent(event);
          });

          socketClient.on("interactive", (rawEvent: unknown) => {
            const event = rawEvent as Record<string, unknown>;
            const payload = (event.payload ?? event) as Record<string, unknown>;
            if (payload.type === "block_actions") {
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
                  } as unknown as import("./normalize.js").SlackBlockAction,
                });
              }
              acknowledgeEvent(event);
            }
          });
        }

        if (features.reactions) {
          socketClient.on("reaction_added", (rawEvent: unknown) => {
            const event = rawEvent as Record<string, unknown>;
            const inner = (event.event ?? event) as Record<string, unknown>;
            handler({
              kind: "reaction_added",
              event: inner as unknown as import("./normalize.js").SlackReactionEvent,
            });
            acknowledgeEvent(event);
          });

          socketClient.on("reaction_removed", (rawEvent: unknown) => {
            const event = rawEvent as Record<string, unknown>;
            const inner = (event.event ?? event) as Record<string, unknown>;
            handler({
              kind: "reaction_removed",
              event: inner as unknown as import("./normalize.js").SlackReactionEvent,
            });
            acknowledgeEvent(event);
          });
        }
      }

      return () => {
        eventHandler = undefined;
        if (socketClient !== undefined) {
          socketClient.removeAllListeners();
        }
      };
    },

    normalize: (event: SlackEvent) => createNormalizer(botUserId)(event),
    platformSendStatus,
    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });

  // Dispatch a parsed Slack event payload through the event handler.
  // Internal helper — not exposed in HTTP mode to prevent unsigned access.
  const dispatchEvent = (payload: unknown): void => {
    if (eventHandler !== undefined && typeof payload === "object" && payload !== null) {
      const p = payload as Record<string, unknown>;
      const eventType = p.type as string | undefined;
      if (eventType === "event_callback") {
        const inner = p.event as Record<string, unknown>;
        const innerType = inner?.type as string | undefined;
        if (innerType === "app_mention") {
          eventHandler({
            kind: "app_mention",
            event: inner as unknown as import("./normalize.js").SlackAppMentionEvent,
          });
        } else if (innerType === "message") {
          eventHandler({
            kind: "message",
            event: inner as unknown as import("./normalize.js").SlackMessageEvent,
          });
        }
      }
    }
  };

  if (config.deployment.mode === "http") {
    // HTTP mode: only expose handleHttpRequest (signature-verified).
    // handleEvent is deliberately NOT exposed to prevent unsigned access.
    const { signingSecret } = config.deployment;
    const handleHttpRequest = async (request: Request): Promise<Response> => {
      const result = await verifySlackRequest(signingSecret, request);
      if (!result.ok) {
        return new Response("Unauthorized", { status: 401 });
      }

      const parsed: unknown = JSON.parse(result.body);
      if (typeof parsed === "object" && parsed !== null) {
        const payload = parsed as Record<string, unknown>;

        // Slack URL verification challenge
        if (payload.type === "url_verification" && typeof payload.challenge === "string") {
          return new Response(payload.challenge, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        dispatchEvent(payload);
      }

      return new Response("OK", { status: 200 });
    };

    return { ...base, handleHttpRequest };
  }

  // Socket mode: expose handleEvent for SDK-verified forwarding (no HTTP handler)
  return { ...base, handleEvent: dispatchEvent } satisfies SlackChannelAdapter;
}

// ---------------------------------------------------------------------------
// Reply-to-mode logic
// ---------------------------------------------------------------------------

import type { SlackReplyToMode } from "./config.js";

/**
 * Adjusts an OutboundMessage's threadId based on the replyToMode setting.
 *
 * - "all": keep threadId as-is (reply in thread when thread_ts present).
 * - "off": strip thread_ts, always post to channel root.
 * - "first": only keep thread_ts if it matches the channel's first message ts
 *   (simplified: we strip thread_ts since we can't know if it's the first).
 */
function applyReplyToMode(message: OutboundMessage, mode: SlackReplyToMode): OutboundMessage {
  if (mode === "all" || message.threadId === undefined) {
    return message;
  }

  if (mode === "off") {
    // Strip thread_ts: "C123:1234.5678" → "C123"
    const idx = message.threadId.indexOf(":");
    if (idx === -1) return message;
    return { ...message, threadId: message.threadId.slice(0, idx) };
  }

  // "first" mode: simplified — keep thread_ts only if explicitly marked.
  // Without server-side knowledge of the first message, fall through to "all".
  return message;
}

// ---------------------------------------------------------------------------
// Client constructors (lazy-loaded to avoid import overhead in tests)
// ---------------------------------------------------------------------------

function createWebClient(token: string): WebClientLike {
  // Dynamic import would be cleaner but TS strict + ESM makes it verbose.
  // @slack/web-api is a declared dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebClient } = require("@slack/web-api") as {
    readonly WebClient: new (token: string) => WebClientLike;
  };
  return new WebClient(token);
}

function createSocketClient(appToken: string): SocketModeClientLike {
  const { SocketModeClient } = require("@slack/socket-mode") as {
    readonly SocketModeClient: new (opts: { readonly appToken: string }) => SocketModeClientLike;
  };
  return new SocketModeClient({ appToken });
}

/** Acknowledges a Socket Mode event if it has an ack function. */
function acknowledgeEvent(event: Record<string, unknown>): void {
  if (typeof event.ack === "function") {
    (event.ack as () => void)();
  }
}
