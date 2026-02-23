/**
 * Generic channel adapter factory.
 *
 * createChannelAdapter<E>() accepts platform-specific callbacks and returns a
 * complete ChannelAdapter that handles all shared channel behavior:
 *
 * - Connection state (idempotent connect)
 * - Handler registration with double-unsubscribe guard
 * - Parallel handler dispatch via Promise.allSettled()
 * - Capability-aware block rendering (renderBlocks) before platformSend
 * - Conditional sendStatus inclusion (absent when not supported)
 * - Observability hooks: onHandlerError, onIgnoredEvent
 *
 * Backpressure note: this factory fires events as they arrive. If the platform
 * sends events faster than handlers can process them, handlers receive calls
 * concurrently. Turn-level sequencing is the engine adapter's responsibility,
 * not the channel's.
 *
 * Queue-on-disconnect: when queueWhenDisconnected is true, send() buffers
 * outbound messages while the channel is disconnected and flushes them in
 * order on the next connect(). When false (default), send() throws if called
 * while disconnected.
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

/**
 * Maps a raw platform event to an InboundMessage, or null to ignore the event.
 *
 * Returning null is the correct response for platform system events that should
 * not trigger agent turns: typing indicators, delivery receipts, poll votes, etc.
 * The factory calls onIgnoredEvent when null is returned — wire this to a debug
 * logger to trace "why didn't the agent respond?" in production.
 */
export type MessageNormalizer<E> = (event: E) => InboundMessage | null;

/**
 * Configuration for createChannelAdapter<E>().
 *
 * Platform adapters provide the platform-specific callbacks. All shared
 * channel behavior is handled by the factory.
 *
 * onPlatformEvent is called inside connect() after platformConnect() completes,
 * so the platform event source is guaranteed to be ready when the listener
 * is registered. The returned unsubscribe function is called inside disconnect()
 * before platformDisconnect() runs.
 */
export interface ChannelAdapterConfig<E> {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;

  /** Called once during connect(). Set up the platform connection here. */
  readonly platformConnect: () => Promise<void>;

  /** Called once during disconnect(). Tear down the platform connection here. */
  readonly platformDisconnect: () => Promise<void>;

  /**
   * Sends a rendered OutboundMessage to the platform.
   * Blocks passed in have already been downgraded by renderBlocks() to match
   * this channel's declared capabilities.
   */
  readonly platformSend: (message: OutboundMessage) => Promise<void>;

  /**
   * Registers a callback to receive raw platform events.
   * Called inside connect() after platformConnect() completes.
   * Returns an unsubscribe function called inside disconnect().
   */
  readonly onPlatformEvent: (handler: (event: E) => void) => () => void;

  /** Converts a raw platform event to an InboundMessage, or null to ignore it. */
  readonly normalize: MessageNormalizer<E>;

  /**
   * If provided, the returned ChannelAdapter will include a sendStatus method.
   * If absent, sendStatus will be omitted from the adapter — consumers can
   * check `adapter.sendStatus !== undefined` to detect support.
   */
  readonly platformSendStatus?: (status: ChannelStatus) => Promise<void>;

  /**
   * Called when a registered message handler throws or rejects.
   * Defaults to console.error. The channel continues processing events
   * even if a handler fails (isolation guarantee).
   *
   * Note: this callback should not throw itself; unhandled errors in it
   * are not caught.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;

  /**
   * Called when normalize() returns null (platform event ignored).
   * Defaults to no-op. Wire to a debug logger to trace missed responses.
   */
  readonly onIgnoredEvent?: (event: E) => void;

  /**
   * When true, send() called while disconnected buffers the message and
   * flushes it in order on the next connect(). Drain errors are logged to
   * console.error but do not fail connect() — the platform connected successfully.
   *
   * When false (default), send() throws if called while disconnected.
   */
  readonly queueWhenDisconnected?: boolean;
}

/**
 * Builds a complete ChannelAdapter from platform-specific callbacks.
 *
 * @param config - Platform callbacks and optional observability hooks.
 * @returns A ChannelAdapter satisfying the @koi/core contract.
 */
export function createChannelAdapter<E>(config: ChannelAdapterConfig<E>): ChannelAdapter {
  const {
    name,
    capabilities,
    platformConnect,
    platformDisconnect,
    platformSend,
    onPlatformEvent,
    normalize,
    platformSendStatus,
    onHandlerError = (err: unknown) => {
      console.error("Channel handler error:", err);
    },
    onIgnoredEvent = (_event: E) => {},
    queueWhenDisconnected = false,
  } = config;

  // let requires justification: mutable connection state managed by connect/disconnect lifecycle
  let connected = false;
  // let requires justification: platform unsubscribe handle acquired on connect, released on disconnect
  let unsubPlatform: (() => void) | undefined;

  // handlers is a small list (typically 1–2 entries).
  // O(N) alloc per subscribe/unsubscribe is intentional and appropriate for this size.
  // let requires justification: handler list updated by onMessage() and its unsubscribe closure
  let handlers: readonly MessageHandler[] = [];

  // let requires justification: outbound queue populated by send() while disconnected,
  // drained sequentially by connect() when queueWhenDisconnected is true
  let sendQueue: readonly OutboundMessage[] = [];

  const dispatchEvent = (event: E): void => {
    const message = normalize(event);
    if (message === null) {
      onIgnoredEvent(event);
      return;
    }

    const currentHandlers = handlers;
    if (currentHandlers.length === 0) {
      return;
    }

    // Parallel dispatch — all handlers run concurrently.
    // InboundMessage is readonly, so concurrent access is safe.
    // Promise.allSettled() never rejects, so no unhandled rejection possible.
    void Promise.allSettled(currentHandlers.map((h) => h(message))).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          // result.reason is typed as any in PromiseRejectedResult; widen to unknown for type safety
          const reason: unknown = result.reason;
          onHandlerError(reason, message);
        }
      }
    });
  };

  const connect = async (): Promise<void> => {
    if (connected) {
      return;
    }
    await platformConnect();
    unsubPlatform = onPlatformEvent(dispatchEvent);
    connected = true;

    // Drain queued messages in order. Errors are logged but do not abort the
    // drain or fail connect() — the platform connected successfully.
    if (sendQueue.length > 0) {
      const queued = sendQueue;
      sendQueue = [];
      for (const msg of queued) {
        try {
          await platformSend(msg);
        } catch (e: unknown) {
          console.error(`[channel:${name}] failed to drain queued message:`, e);
        }
      }
    }
  };

  const disconnect = async (): Promise<void> => {
    // Unsubscribe the platform event listener before disconnecting to avoid
    // stale events arriving during teardown.
    unsubPlatform?.();
    unsubPlatform = undefined;
    connected = false;
    await platformDisconnect();
  };

  const send = async (message: OutboundMessage): Promise<void> => {
    const renderedContent = renderBlocks(message.content, capabilities);
    // Avoid allocation when renderBlocks returns the same reference (fast path).
    const rendered =
      renderedContent === message.content ? message : { ...message, content: renderedContent };

    if (!connected) {
      if (queueWhenDisconnected) {
        sendQueue = [...sendQueue, rendered];
        return;
      }
      throw new Error(`Channel "${name}" is not connected`);
    }

    await platformSend(rendered);
  };

  const onMessage = (handler: MessageHandler): (() => void) => {
    handlers = [...handlers, handler];
    // let requires justification: one-shot guard to prevent double-unsubscribe
    let removed = false;

    return (): void => {
      if (removed) {
        return;
      }
      removed = true;
      handlers = handlers.filter((h) => h !== handler);
    };
  };

  // Build the base adapter. sendStatus is conditionally included:
  // if platformSendStatus is not provided, sendStatus is absent from the adapter
  // (not a no-op) so consumers can detect capability via `adapter.sendStatus !== undefined`.
  const base: ChannelAdapter = {
    name,
    capabilities,
    connect,
    disconnect,
    send,
    onMessage,
  };

  if (platformSendStatus !== undefined) {
    return { ...base, sendStatus: platformSendStatus };
  }
  return base;
}
