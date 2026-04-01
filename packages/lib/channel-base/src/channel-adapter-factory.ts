/**
 * Generic factory that builds a complete ChannelAdapter from platform-specific callbacks.
 *
 * Handles shared channel plumbing: connection lifecycle (idempotent connect/disconnect),
 * handler dispatch (parallel via Promise.allSettled), capability-aware block rendering
 * (renderBlocks before platformSend), and error isolation.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import { renderBlocks } from "./render-blocks.js";

/** Transforms a platform-specific event into an InboundMessage (or null to skip). */
export type MessageNormalizer<E> = (
  event: E,
) => InboundMessage | null | Promise<InboundMessage | null>;

/** Platform-specific callbacks the factory needs to build a ChannelAdapter. */
export interface ChannelAdapterConfig<E> {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;

  /** Connect to the platform (create readline, open websocket, etc.). */
  readonly platformConnect: () => Promise<void>;
  /** Disconnect from the platform (close readline, close websocket, etc.). */
  readonly platformDisconnect: () => Promise<void>;
  /** Write an OutboundMessage to the platform. Blocks already downgraded by renderBlocks(). */
  readonly platformSend: (message: OutboundMessage) => Promise<void>;
  /** Register a listener for platform events. Returns an unsubscribe function. */
  readonly onPlatformEvent: (handler: (event: E) => void) => () => void;
  /** Convert a platform event into an InboundMessage. */
  readonly normalize: MessageNormalizer<E>;

  /** Optional: write status indicators to the platform. */
  readonly platformSendStatus?: ((status: ChannelStatus) => Promise<void>) | undefined;
  /** Called when a handler throws during dispatch. Defaults to silent. */
  readonly onHandlerError?: ((err: unknown, message: InboundMessage) => void) | undefined;
  /** Called when normalize() throws or rejects. Defaults to silent drop. */
  readonly onNormalizationError?: ((error: unknown, rawEvent: E) => void) | undefined;
}

/**
 * Creates a complete ChannelAdapter from platform-specific callbacks.
 *
 * @typeParam E - The platform-specific event type (e.g., `string` for readline lines).
 */
export function createChannelAdapter<E>(config: ChannelAdapterConfig<E>): ChannelAdapter {
  // let requires justification: mutable connection state managed by lifecycle methods
  let connected = false;
  // let requires justification: serializes concurrent connect/disconnect calls
  let lifecycleChain: Promise<void> = Promise.resolve();
  let handlers: ReadonlyArray<{ readonly fn: MessageHandler; readonly id: number }> = [];
  // let requires justification: monotonic counter for unique subscription IDs
  let nextHandlerId = 0;
  let unsubPlatform: (() => void) | undefined;
  // let requires justification: tracks in-flight send() calls so disconnect() can drain them
  let inflightSends: ReadonlySet<Promise<void>> = new Set();

  async function dispatch(message: InboundMessage): Promise<void> {
    const results = await Promise.allSettled(handlers.map((h) => h.fn(message)));
    for (const result of results) {
      if (result.status === "rejected") {
        config.onHandlerError?.(result.reason, message);
      }
    }
  }

  /** Queues an async lifecycle operation so concurrent calls execute sequentially. */
  function enqueueLifecycle(op: () => Promise<void>): Promise<void> {
    lifecycleChain = lifecycleChain.then(op, op);
    return lifecycleChain;
  }

  const base = {
    name: config.name,
    capabilities: config.capabilities,

    connect: (): Promise<void> =>
      enqueueLifecycle(async () => {
        if (connected) return;
        await config.platformConnect();

        // Treat listener registration as part of the atomic connect step.
        // If onPlatformEvent() throws, roll back platformConnect() so the
        // adapter doesn't get wedged in a half-initialized state.
        try {
          unsubPlatform = config.onPlatformEvent((event: E) => {
            const normalized = config.normalize(event);
            if (normalized instanceof Promise) {
              normalized
                .then((msg) => {
                  if (msg !== null) return dispatch(msg);
                })
                .catch((err: unknown) => {
                  config.onNormalizationError?.(err, event);
                });
            } else if (normalized !== null) {
              dispatch(normalized).catch(() => {
                // Dispatch errors already handled by onHandlerError
              });
            }
          });
        } catch (err: unknown) {
          await config.platformDisconnect();
          throw err;
        }

        connected = true;
      }),

    disconnect: (): Promise<void> =>
      enqueueLifecycle(async () => {
        if (!connected) return;
        // Set connected=false BEFORE teardown so new send() calls are
        // rejected immediately once disconnect begins.
        connected = false;
        // Wait for any in-flight sends to settle before tearing down
        // the transport, preventing writes into a closing channel.
        if (inflightSends.size > 0) {
          await Promise.allSettled([...inflightSends]);
        }
        unsubPlatform?.();
        unsubPlatform = undefined;
        await config.platformDisconnect();
      }),

    send: async (message: OutboundMessage): Promise<void> => {
      if (!connected) {
        throw new Error(`Channel "${config.name}" is not connected`);
      }
      const rendered: OutboundMessage = {
        ...message,
        content: renderBlocks(message.content, config.capabilities),
      };
      const sendOp = config.platformSend(rendered);
      const tracked = sendOp.then(
        () => {
          inflightSends = new Set([...inflightSends].filter((p) => p !== tracked));
        },
        () => {
          inflightSends = new Set([...inflightSends].filter((p) => p !== tracked));
        },
      );
      inflightSends = new Set([...inflightSends, tracked]);
      await sendOp;
    },

    onMessage: (handler: MessageHandler): (() => void) => {
      const id = nextHandlerId++;
      handlers = [...handlers, { fn: handler, id }];
      // let requires justification: tracks whether this specific subscription is active
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers = handlers.filter((h) => h.id !== id);
      };
    },
  };

  // Conditionally add sendStatus — exactOptionalPropertyTypes forbids setting it to undefined
  if (config.platformSendStatus !== undefined) {
    const platformSendStatus = config.platformSendStatus;
    return {
      ...base,
      sendStatus: async (status: ChannelStatus): Promise<void> => {
        if (!connected) return;
        await platformSendStatus(status);
      },
    };
  }

  return base;
}
