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
 * - Observability hooks: onHandlerError, onIgnoredEvent, onNormalizationError
 * - Connect timeout (connectTimeoutMs)
 * - Bounded disconnect queue (maxQueueSize, drop-oldest on overflow)
 * - Health check (lastEventAt tracking)
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
import type { RetryConfig } from "@koi/errors";
import { swallowError } from "@koi/errors";
import type { DisconnectInfo } from "./reconnect.js";
import { createReconnector } from "./reconnect.js";
import { renderBlocks } from "./render-blocks.js";

/** Health status snapshot returned by the optional healthCheck() method. */
export interface HealthStatus {
  readonly healthy: boolean;
  readonly lastEventAt: number;
  readonly reconnectAttempts: number;
  readonly lastDisconnect?: DisconnectInfo;
}

/**
 * Maps a raw platform event to an InboundMessage, or null to ignore the event.
 * May return a Promise for platforms that need an async API call during normalization
 * (e.g., resolving a file URL from a file_id before building an ImageBlock).
 *
 * Returning null is the correct response for platform system events that should
 * not trigger agent turns: typing indicators, delivery receipts, poll votes, etc.
 * The factory calls onIgnoredEvent when null is returned — wire this to a debug
 * logger to trace "why didn't the agent respond?" in production.
 */
export type MessageNormalizer<E> = (
  event: E,
) => InboundMessage | null | Promise<InboundMessage | null>;

/** Policy for automatic reconnection on platform disconnect. */
export interface ReconnectPolicy {
  /** Retry configuration. Defaults to DEFAULT_RECONNECT_CONFIG (decorrelated jitter). */
  readonly retry?: RetryConfig;
  /** Called when all reconnect attempts are exhausted. */
  readonly onReconnectFailed?: (lastError: unknown, info?: DisconnectInfo) => void;
  /** Called on each reconnect attempt (for logging/observability). */
  readonly onReconnecting?: (attempt: number) => void;
  /** Return false to skip reconnect for this disconnect. Default: always reconnect. */
  readonly shouldReconnect?: (info: DisconnectInfo) => boolean;
}

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

  /**
   * Maximum time in milliseconds to wait for platformConnect() to complete.
   * If exceeded, connect() rejects with a timeout error.
   * Set to 0 to disable the timeout. Defaults to 30_000 (30 seconds).
   */
  readonly connectTimeoutMs?: number;

  /**
   * Maximum number of messages to buffer when queueWhenDisconnected is true.
   * When the queue exceeds this limit, the oldest message is dropped and a
   * warning is logged. Defaults to 1_000.
   */
  readonly maxQueueSize?: number;

  /**
   * Called when normalize() throws or rejects. Receives the error and the
   * raw platform event that caused it. The event is still treated as ignored
   * (null) — handlers are not called.
   *
   * If not provided, a warning is logged to console.warn.
   */
  readonly onNormalizationError?: (error: unknown, rawEvent: E) => void;

  /**
   * Timeout in milliseconds for the health check. If no event has been
   * dispatched within this window, healthCheck() reports unhealthy.
   * Defaults to 300_000 (5 minutes). Set to 0 to disable staleness detection.
   */
  readonly healthTimeoutMs?: number;

  /**
   * When provided, auto-reconnect on platform disconnect with bounded retries.
   * Requires onPlatformDisconnect to be set to detect connection drops.
   */
  readonly reconnect?: ReconnectPolicy;

  /**
   * Called by the platform when the underlying connection drops unexpectedly.
   * Returns an unsubscribe function. When reconnect is configured, this triggers
   * the reconnect loop. When not configured, the adapter stays disconnected.
   */
  readonly onPlatformDisconnect?: (handler: (info?: DisconnectInfo) => void) => () => void;
}

/**
 * Builds a complete ChannelAdapter from platform-specific callbacks.
 *
 * @param config - Platform callbacks and optional observability hooks.
 * @returns A ChannelAdapter satisfying the @koi/core contract.
 */
/** Default connect timeout: 30 seconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Default max queue size for disconnect buffering. */
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

/** Default health timeout: 5 minutes. */
const DEFAULT_HEALTH_TIMEOUT_MS = 300_000;

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
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    onNormalizationError = (error: unknown, _rawEvent: E) => {
      console.warn(`[channel-base] Normalization error in "${name}":`, error);
    },
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    reconnect: reconnectPolicy,
    onPlatformDisconnect,
  } = config;

  // let requires justification: mutable connection state managed by connect/disconnect lifecycle
  let connected = false;
  // let requires justification: platform unsubscribe handle acquired on connect, released on disconnect
  let unsubPlatform: (() => void) | undefined;
  // let requires justification: tracks whether a reconnect loop is active for healthCheck
  let reconnecting = false;
  // let requires justification: disconnect listener unsubscribe acquired on connect
  let unsubDisconnect: (() => void) | undefined;
  // let requires justification: tracks last disconnect info for healthCheck enrichment
  let lastDisconnect: DisconnectInfo | undefined;
  // let requires justification: tracks reconnect attempts for healthCheck enrichment
  let currentReconnectAttempts = 0;
  // let requires justification: active reconnector instance, must be stoppable from disconnect()
  let activeReconnector: ReturnType<typeof createReconnector> | undefined;

  // handlers is a small list (typically 1–2 entries).
  // O(N) alloc per subscribe/unsubscribe is intentional and appropriate for this size.
  // let requires justification: handler list updated by onMessage() and its unsubscribe closure
  let handlers: readonly MessageHandler[] = [];

  // let requires justification: outbound queue populated by send() while disconnected,
  // drained sequentially by connect() when queueWhenDisconnected is true
  let sendQueue: readonly OutboundMessage[] = [];

  // let requires justification: tracks dropped message count for observability
  let droppedCount = 0;

  // let requires justification: tracks last event dispatch timestamp for health check
  let lastEventAt = 0;

  const dispatchEvent = (event: E): void => {
    // Normalize may be sync or async — always treat as Promise for uniform handling.
    // Wrap in try/catch for sync errors, then .catch for async errors.
    // let requires justification: normalizeResult may be sync or async
    let normalizeResult: InboundMessage | null | Promise<InboundMessage | null>;
    try {
      normalizeResult = normalize(event);
    } catch (e: unknown) {
      onNormalizationError(e, event);
      return;
    }

    void Promise.resolve(normalizeResult)
      .catch((e: unknown) => {
        onNormalizationError(e, event);
        return null;
      })
      .then((message) => {
        // Update health tracking on every dispatched event (before null check,
        // because system events like typing indicators still prove the connection is alive).
        lastEventAt = Date.now();

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
      });
  };

  const connect = async (): Promise<void> => {
    if (connected) {
      return;
    }

    // Apply connect timeout if configured (0 = disabled)
    if (connectTimeoutMs > 0) {
      // let justified: timer handle must be captured for cleanup after Promise.race
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
          reject(new Error(`Channel "${name}" connect timed out after ${connectTimeoutMs}ms`));
        }, connectTimeoutMs);
      });
      try {
        await Promise.race([platformConnect(), timeout]);
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
      }
    } else {
      await platformConnect();
    }

    unsubPlatform = onPlatformEvent(dispatchEvent);
    connected = true;
    reconnecting = false;

    // Subscribe to platform disconnect events for auto-reconnect
    if (reconnectPolicy !== undefined && onPlatformDisconnect !== undefined) {
      unsubDisconnect?.();
      unsubDisconnect = onPlatformDisconnect((info) => {
        if (!connected) return;
        connected = false;
        lastDisconnect = info;

        // Check shouldReconnect predicate before entering the reconnect loop
        if (
          reconnectPolicy.shouldReconnect !== undefined &&
          !reconnectPolicy.shouldReconnect(info ?? {})
        ) {
          reconnectPolicy.onReconnectFailed?.(
            new Error(`Reconnect skipped: non-retryable disconnect (code=${String(info?.code)})`),
            info,
          );
          // Tear down platform event listener — adapter stays disconnected
          unsubPlatform?.();
          unsubPlatform = undefined;
          return;
        }

        reconnecting = true;
        // Tear down the current platform event listener
        unsubPlatform?.();
        unsubPlatform = undefined;

        // Stop any previous reconnector before creating a new one
        activeReconnector?.stop();
        const reconnector = createReconnector({
          connect: async () => {
            currentReconnectAttempts = reconnector.attempts();
            reconnectPolicy.onReconnecting?.(reconnector.attempts());
            await platformConnect();
          },
          onConnected: () => {
            // Re-subscribe to platform events after successful reconnect
            unsubPlatform = onPlatformEvent(dispatchEvent);
            connected = true;
            reconnecting = false;
            currentReconnectAttempts = 0;

            // Re-subscribe to platform disconnect for next drop
            unsubDisconnect?.();
            if (onPlatformDisconnect !== undefined) {
              unsubDisconnect = onPlatformDisconnect((nextInfo) => {
                if (!connected) return;
                connected = false;
                lastDisconnect = nextInfo;

                // Check shouldReconnect on subsequent disconnects too
                if (
                  reconnectPolicy.shouldReconnect !== undefined &&
                  !reconnectPolicy.shouldReconnect(nextInfo ?? {})
                ) {
                  reconnectPolicy.onReconnectFailed?.(
                    new Error(
                      `Reconnect skipped: non-retryable disconnect (code=${String(nextInfo?.code)})`,
                    ),
                    nextInfo,
                  );
                  unsubPlatform?.();
                  unsubPlatform = undefined;
                  return;
                }

                reconnecting = true;
                unsubPlatform?.();
                unsubPlatform = undefined;
                reconnector.reconnect(nextInfo);
              });
            }

            // Drain queued messages sequentially after reconnect (preserves FIFO order)
            if (sendQueue.length > 0) {
              const queued = sendQueue;
              sendQueue = [];
              droppedCount = 0;
              void (async (): Promise<void> => {
                for (const msg of queued) {
                  try {
                    await platformSend(msg);
                  } catch (e: unknown) {
                    swallowError(e, { package: "channel-base", operation: `drain[${name}]` });
                  }
                }
              })();
            }
          },
          onDisconnected: () => {
            // Already handled above — this fires on subsequent reconnect triggers
          },
          onGiveUp: (lastError, lastInfo) => {
            reconnecting = false;
            activeReconnector = undefined;
            reconnectPolicy.onReconnectFailed?.(lastError, lastInfo);
          },
          ...(reconnectPolicy.retry !== undefined && { retry: reconnectPolicy.retry }),
        });
        activeReconnector = reconnector;

        reconnector.reconnect(info);
      });
    }

    // Drain queued messages in order. Errors are logged but do not abort the
    // drain or fail connect() — the platform connected successfully.
    if (sendQueue.length > 0) {
      const queued = sendQueue;
      sendQueue = [];
      droppedCount = 0;
      for (const msg of queued) {
        try {
          await platformSend(msg);
        } catch (e: unknown) {
          swallowError(e, { package: "channel-base", operation: `drain[${name}]` });
        }
      }
    }
  };

  const disconnect = async (): Promise<void> => {
    // Unsubscribe the platform event listener before disconnecting to avoid
    // stale events arriving during teardown.
    unsubPlatform?.();
    unsubPlatform = undefined;
    // Unsubscribe disconnect listener and stop any active reconnect
    unsubDisconnect?.();
    unsubDisconnect = undefined;
    // Stop the active reconnector to prevent it from reconnecting after disconnect()
    activeReconnector?.stop();
    activeReconnector = undefined;
    reconnecting = false;
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
        if (sendQueue.length >= maxQueueSize) {
          // Drop oldest message to make room
          sendQueue = sendQueue.slice(1);
          droppedCount += 1;
          console.warn(
            `[channel-base] "${name}" queue full (max=${maxQueueSize}), dropped oldest message (total dropped: ${droppedCount})`,
          );
        }
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

  const healthCheck = (): HealthStatus => {
    const base = {
      lastEventAt,
      reconnectAttempts: currentReconnectAttempts,
      ...(lastDisconnect !== undefined ? { lastDisconnect } : {}),
    };
    if (!connected || reconnecting) {
      return { healthy: false, ...base };
    }
    if (healthTimeoutMs === 0) {
      // Staleness detection disabled — connected means healthy
      return { healthy: true, ...base };
    }
    const stale = lastEventAt > 0 && Date.now() - lastEventAt > healthTimeoutMs;
    return { healthy: !stale, ...base };
  };

  // Build the base adapter. sendStatus is conditionally included:
  // if platformSendStatus is not provided, sendStatus is absent from the adapter
  // (not a no-op) so consumers can detect capability via `adapter.sendStatus !== undefined`.
  const base: ChannelAdapter & { readonly healthCheck: () => HealthStatus } = {
    name,
    capabilities,
    connect,
    disconnect,
    send,
    onMessage,
    healthCheck,
  };

  if (platformSendStatus !== undefined) {
    return { ...base, sendStatus: platformSendStatus };
  }
  return base;
}
