/**
 * Factory for the mobile WebSocket channel adapter.
 *
 * Creates a Bun WebSocket server that mobile clients connect to.
 * Supports bearer token auth, heartbeat, and mobile-native tool invocation.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelCapabilities, ChannelStatus, OutboundMessage } from "@koi/core";
import type { MobileChannelAdapter, MobileChannelConfig } from "./config.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from "./config.js";
import { createNormalizer } from "./normalize.js";
import { createPlatformSend } from "./platform-send.js";
import type { MobileInboundFrame } from "./protocol.js";
import { createRateLimiter } from "./rate-limit.js";

const MOBILE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

interface ClientState {
  readonly ws: { readonly send: (data: string) => void };
  readonly id: string;
  readonly authenticated: boolean;
}

/**
 * Creates a mobile channel adapter backed by a Bun WebSocket server.
 *
 * Mobile clients connect via WebSocket and exchange JSON frames defined
 * in protocol.ts. The adapter exposes mobile-native tools (camera, GPS, etc.)
 * that the agent can invoke on the client device.
 */
export function createMobileChannel(config: MobileChannelConfig): MobileChannelAdapter {
  const port = config.port;
  const hostname = config.hostname ?? "0.0.0.0";
  const tools = config.tools ?? [];
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const requireAuth = config.features?.requireAuth === true;
  const enableHeartbeat = config.features?.heartbeat !== false;
  const rateLimiter =
    config.features?.rateLimit !== undefined
      ? createRateLimiter(config.features.rateLimit)
      : undefined;

  // let: mutable state for connected clients, managed by connect/disconnect lifecycle
  let clients = new Map<string, ClientState>();
  // let: mutable reference to event handler, set by onPlatformEvent
  let eventHandler: ((frame: MobileInboundFrame) => void) | undefined;
  // let: server instance reference for cleanup
  let server: { readonly stop: (closeActiveConnections?: boolean) => void } | undefined;
  // let: heartbeat interval timer
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  // let: monotonic client ID counter
  let nextClientId = 0;

  const getClients = (): ReadonlyMap<string, { readonly send: (data: string) => void }> => {
    const senders = new Map<string, { readonly send: (data: string) => void }>();
    for (const [id, state] of clients) {
      senders.set(id, state.ws);
    }
    return senders;
  };

  const platformSend = createPlatformSend(getClients);

  const base = createChannelAdapter<MobileInboundFrame>({
    name: "mobile",
    capabilities: MOBILE_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      if (config._server !== undefined) {
        server = config._server as typeof server;
        return;
      }

      server = Bun.serve({
        port,
        hostname,
        fetch(req, srv) {
          const upgraded = srv.upgrade(req);
          if (!upgraded) {
            return new Response("WebSocket upgrade required", { status: 426 });
          }
          return undefined;
        },
        websocket: {
          maxPayloadLength: maxPayloadBytes,
          idleTimeout: Math.floor(idleTimeoutMs / 1000),
          open(ws) {
            const clientId = String(nextClientId++);
            (ws as unknown as { data: { id: string } }).data = { id: clientId };
            clients.set(clientId, {
              ws: { send: (data: string) => ws.send(data) },
              id: clientId,
              authenticated: !requireAuth,
            });
          },
          message(ws, rawMessage) {
            const data = ws.data as { readonly id: string } | undefined;
            const clientId = data?.id ?? "unknown";
            try {
              const text =
                typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
              const frame = JSON.parse(text) as MobileInboundFrame;

              // Handle auth frames
              if (frame.kind === "auth") {
                if (requireAuth && frame.token === config.authToken) {
                  const existing = clients.get(clientId);
                  if (existing !== undefined) {
                    clients.set(clientId, { ...existing, authenticated: true });
                  }
                } else if (requireAuth) {
                  ws.send(JSON.stringify({ kind: "error", message: "Authentication failed" }));
                  ws.close(4001, "Authentication failed");
                }
                return;
              }

              // Handle ping frames
              if (frame.kind === "ping") {
                ws.send(JSON.stringify({ kind: "pong" }));
                return;
              }

              // Reject unauthenticated messages
              const clientState = clients.get(clientId);
              if (clientState !== undefined && !clientState.authenticated) {
                ws.send(JSON.stringify({ kind: "error", message: "Not authenticated" }));
                return;
              }

              // Rate limit check (OpenClaw pattern: per-client sliding window)
              if (rateLimiter !== undefined) {
                const result = rateLimiter.check(clientId);
                if (!result.allowed) {
                  ws.send(
                    JSON.stringify({
                      kind: "error",
                      message: "Rate limit exceeded",
                      retryAfterMs: result.retryAfterMs,
                    }),
                  );
                  return;
                }
              }

              // Inject threadId for messages without one
              const enrichedFrame: MobileInboundFrame =
                frame.kind === "message" && frame.threadId === undefined
                  ? { ...frame, threadId: `mobile:${clientId}` }
                  : frame;

              eventHandler?.(enrichedFrame);
            } catch (e: unknown) {
              ws.send(
                JSON.stringify({
                  kind: "error",
                  message: e instanceof Error ? e.message : "Invalid frame",
                }),
              );
            }
          },
          close(ws) {
            const data = ws.data as { readonly id: string } | undefined;
            if (data !== undefined) {
              clients.delete(data.id);
              rateLimiter?.reset(data.id);
            }
          },
        },
      });

      if (enableHeartbeat) {
        heartbeatTimer = setInterval(() => {
          const pongFrame = JSON.stringify({ kind: "pong" });
          for (const state of clients.values()) {
            state.ws.send(pongFrame);
          }
        }, heartbeatIntervalMs);
      }
    },

    platformDisconnect: async (): Promise<void> => {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (server !== undefined && config._server === undefined) {
        server.stop(true);
        server = undefined;
      }
      clients = new Map();
      rateLimiter?.resetAll();
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await platformSend(message);
    },

    onPlatformEvent: (handler: (event: MobileInboundFrame) => void): (() => void) => {
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },

    normalize: createNormalizer(),

    platformSendStatus: async (status: ChannelStatus): Promise<void> => {
      const frame = { kind: "status" as const, status };
      const payload = JSON.stringify(frame);
      for (const state of clients.values()) {
        if (state.authenticated) {
          state.ws.send(payload);
        }
      }
    },

    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });

  return {
    ...base,
    tools,
    connectedClients: () => clients.size,
  };
}
