/**
 * Factory for the Matrix channel adapter.
 *
 * Uses matrix-bot-sdk to connect to a Matrix homeserver.
 * Supports auto-join, debouncing, and filtered sync.
 */

import { createChannelAdapter, createDebouncer, createRetryQueue } from "@koi/channel-base";
import type { ChannelCapabilities, OutboundMessage } from "@koi/core";
import type { MatrixChannelConfig } from "./config.js";
import { DEFAULT_MATRIX_DEBOUNCE_MS } from "./config.js";
import type { MatrixRoomEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";
import type { MatrixSender } from "./platform-send.js";
import { createPlatformSend } from "./platform-send.js";
import { createSyncFilter } from "./sync-filter.js";

const MATRIX_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/** Minimal MatrixClient interface for dependency injection. */
interface MatrixClientLike {
  readonly getUserId: () => Promise<string>;
  readonly start: (filter?: unknown) => Promise<void>;
  readonly stop: () => void;
  readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
  readonly off: (event: string, handler: (...args: readonly unknown[]) => void) => void;
  readonly sendText: (roomId: string, text: string) => Promise<string>;
  readonly sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
  readonly joinRoom: (roomIdOrAlias: string) => Promise<string>;
}

/**
 * Creates a Matrix channel adapter.
 *
 * Connects to a Matrix homeserver using the matrix-bot-sdk,
 * normalizes room events to InboundMessage, and sends
 * OutboundMessage as Matrix room messages.
 */
export function createMatrixChannel(
  config: MatrixChannelConfig,
): ReturnType<typeof createChannelAdapter> {
  const debounceMs = config.debounceMs ?? DEFAULT_MATRIX_DEBOUNCE_MS;
  const autoJoin = config.autoJoin !== false;

  // let: resolved after connect when we know the bot's user ID
  let botUserId = "";
  // let: event handler reference for cleanup
  let eventHandler: ((...args: readonly unknown[]) => void) | undefined;
  // let: room invite handler for auto-join
  let inviteHandler: ((...args: readonly unknown[]) => void) | undefined;

  const debouncer = debounceMs > 0 ? createDebouncer({ windowMs: debounceMs }) : undefined;

  async function getClient(): Promise<MatrixClientLike> {
    if (config._client !== undefined) {
      return config._client as MatrixClientLike;
    }

    // Dynamic import to avoid bundling matrix-bot-sdk when not used
    const sdk = await import("matrix-bot-sdk");
    const storage = new sdk.SimpleFsStorageProvider(config.storagePath ?? "./matrix-storage");
    return new sdk.MatrixClient(config.homeserverUrl, config.accessToken, storage);
  }

  // let: client reference
  let client: MatrixClientLike | undefined;

  const syncFilter = createSyncFilter();

  const makeSend = (sender: MatrixSender) => createPlatformSend(sender);

  // Send queue to serialize outbound messages (OpenClaw pattern: prevents homeserver rate limiting)
  const sendQueue = createRetryQueue();

  const base = createChannelAdapter<MatrixRoomEvent>({
    name: "matrix",
    capabilities: MATRIX_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      client = await getClient();
      botUserId = await client.getUserId();

      if (autoJoin && client.on !== undefined) {
        inviteHandler = (roomId: unknown) => {
          if (typeof roomId === "string") {
            void client?.joinRoom(roomId);
          }
        };
        client.on("room.invite", inviteHandler);
      }

      await client.start(syncFilter);
    },

    platformDisconnect: async (): Promise<void> => {
      debouncer?.dispose();
      if (client !== undefined) {
        if (inviteHandler !== undefined) {
          client.off("room.invite", inviteHandler);
          inviteHandler = undefined;
        }
        client.stop();
        client = undefined;
      }
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      if (client === undefined) {
        throw new Error("[channel-matrix] Cannot send: client not connected");
      }
      const send = makeSend(client);
      await sendQueue.enqueue(async () => send(message));
    },

    onPlatformEvent: (handler: (event: MatrixRoomEvent) => void): (() => void) => {
      eventHandler = (roomId: unknown, event: unknown) => {
        if (event !== null && typeof event === "object" && "type" in event) {
          // Inject room_id from the first argument (matrix-bot-sdk passes it separately)
          const enriched =
            typeof roomId === "string"
              ? { ...(event as Record<string, unknown>), room_id: roomId }
              : event;
          handler(enriched as MatrixRoomEvent);
        }
      };
      // Register when client is available (deferred to after connect)
      if (client !== undefined) {
        client.on("room.message", eventHandler);
      }
      return () => {
        if (client !== undefined && eventHandler !== undefined) {
          client.off("room.message", eventHandler);
        }
        eventHandler = undefined;
      };
    },

    normalize: (event: MatrixRoomEvent) => createNormalizer(botUserId)(event),

    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });

  return base;
}
