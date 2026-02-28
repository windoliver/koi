/**
 * Factory for the Teams channel adapter.
 *
 * Uses an HTTP webhook to receive Bot Framework Activities from Teams.
 * Sends responses via stored turn contexts. The actual Microsoft SDK
 * integration is handled by the descriptor's factory for manifest resolution.
 */

import { createChannelAdapter, createRetryQueue } from "@koi/channel-base";
import type { ChannelCapabilities, OutboundMessage } from "@koi/core";
import type { TeamsActivity, TeamsConversationReference } from "./activity-types.js";
import type { TeamsChannelAdapter, TeamsChannelConfig } from "./config.js";
import { DEFAULT_TEAMS_PORT } from "./config.js";
import { createNormalizer } from "./normalize.js";
import type { TeamsTurnContext, TurnContextStore } from "./platform-send.js";
import { createPlatformSend } from "./platform-send.js";

const TEAMS_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/**
 * Creates a Teams channel adapter.
 *
 * Receives Bot Framework Activities via HTTP webhook, normalizes them
 * to InboundMessage, and sends responses via stored turn contexts.
 */
export function createTeamsChannel(config: TeamsChannelConfig): TeamsChannelAdapter {
  const appId = config.appId;
  const port = config.port ?? DEFAULT_TEAMS_PORT;

  // let: turn context store — maps conversationId → most recent TurnContext
  const contextMap = new Map<string, TeamsTurnContext>();
  const contextStore: TurnContextStore = {
    get: (id: string) => contextMap.get(id),
    set: (id: string, ctx: TeamsTurnContext) => {
      contextMap.set(id, ctx);
    },
  };

  // Conversation reference store for proactive messaging (OpenClaw pattern)
  const conversationRefs = new Map<string, TeamsConversationReference>();

  /** Extract and store a conversation reference from an incoming activity. */
  const storeConversationRef = (activity: TeamsActivity): void => {
    if (activity.serviceUrl !== undefined && activity.conversation !== undefined) {
      conversationRefs.set(activity.conversation.id, {
        conversationId: activity.conversation.id,
        serviceUrl: activity.serviceUrl,
        botId: appId,
        ...(activity.conversation.tenantId !== undefined
          ? { tenantId: activity.conversation.tenantId }
          : {}),
      });
    }
  };

  // let: event handler for incoming activities
  let eventHandler: ((activity: TeamsActivity) => void) | undefined;
  // let: HTTP server reference for cleanup
  let server: { readonly stop: (closeActiveConnections?: boolean) => void } | undefined;

  const sendFn = createPlatformSend(contextStore);

  // Retry queue with Retry-After header extraction (OpenClaw pattern)
  const retryQueue = createRetryQueue({
    extractRetryAfterMs: (error: unknown): number | undefined => {
      // Bot Framework returns 429 with Retry-After header value in seconds
      if (error !== null && typeof error === "object" && "retryAfter" in error) {
        const val = (error as { readonly retryAfter: unknown }).retryAfter;
        if (typeof val === "number") {
          return val * 1000;
        }
      }
      return undefined;
    },
  });

  const base = createChannelAdapter<TeamsActivity>({
    name: "teams",
    capabilities: TEAMS_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      if (config._agent !== undefined) {
        // Test mode: skip server setup
        return;
      }

      server = Bun.serve({
        port,
        async fetch(req) {
          if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          try {
            const body = (await req.json()) as TeamsActivity;

            // Store a simple turn context for responses
            if (body.conversation !== undefined) {
              contextStore.set(body.conversation.id, {
                sendActivity: async () => {
                  // In production, this would use the Bot Framework SDK's proactive messaging.
                  // For now, responses are sent inline during the activity handler.
                },
              });
            }

            eventHandler?.(body);
            return new Response("OK", { status: 200 });
          } catch {
            return new Response("Bad request", { status: 400 });
          }
        },
      });
    },

    platformDisconnect: async (): Promise<void> => {
      if (server !== undefined && config._agent === undefined) {
        server.stop(true);
        server = undefined;
      }
      contextMap.clear();
      conversationRefs.clear();
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await retryQueue.enqueue(async () => sendFn(message));
    },

    onPlatformEvent: (handler: (activity: TeamsActivity) => void): (() => void) => {
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },

    normalize: createNormalizer(appId),

    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });

  return {
    ...base,
    handleActivity: async (activity: unknown): Promise<void> => {
      const act = activity as TeamsActivity;
      if (act.conversation !== undefined) {
        contextStore.set(act.conversation.id, {
          sendActivity: async () => {
            // Placeholder for proactive messaging
          },
        });
        storeConversationRef(act);
      }
      eventHandler?.(act);
    },
    conversationReferences: () =>
      conversationRefs as ReadonlyMap<string, TeamsConversationReference>,
  };
}
