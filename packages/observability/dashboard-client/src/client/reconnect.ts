/**
 * Auto-reconnect with exponential backoff for SSE streams.
 *
 * Handles:
 * - Exponential backoff (100ms → 200ms → 400ms → ... → 5s cap)
 * - Jitter to avoid thundering herd
 * - Last-Event-ID for server-side replay
 * - Max retry limit → manual reconnect prompt
 * - Status callbacks for UI feedback
 */

import { consumeSSEStream, type SSEEvent } from "./sse-stream.js";

/** Reconnection configuration. */
export interface ReconnectConfig {
  /** Initial delay in ms (default: 100). */
  readonly initialDelayMs?: number;
  /** Maximum delay in ms (default: 5000). */
  readonly maxDelayMs?: number;
  /** Maximum attempts before giving up (default: 5). */
  readonly maxAttempts?: number;
  /** Jitter factor (0-1, default: 0.3). */
  readonly jitterFactor?: number;
}

/** Status updates for the UI. */
export type ReconnectStatus =
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: "failed"; readonly attempt: number };

/** Callbacks for the reconnecting SSE consumer. */
export interface ReconnectCallbacks {
  readonly onEvent: (event: SSEEvent) => void;
  readonly onStatus: (status: ReconnectStatus) => void;
}

/** Handle to control the reconnecting consumer. */
export interface ReconnectHandle {
  /** Stop reconnecting and close the stream. */
  readonly stop: () => void;
  /** Reset retry counter (call after successful event receipt). */
  readonly resetRetries: () => void;
}

/** Function that initiates a fetch request to the SSE endpoint. */
export type SSEFetcher = (lastEventId: string | undefined) => Promise<Response>;

/**
 * Create a self-reconnecting SSE consumer.
 *
 * Automatically reconnects with exponential backoff when the stream drops.
 * Passes Last-Event-ID to the fetcher for server-side replay.
 */
export function createReconnectingStream(
  fetcher: SSEFetcher,
  callbacks: ReconnectCallbacks,
  config: ReconnectConfig = {},
): ReconnectHandle {
  const { initialDelayMs = 100, maxDelayMs = 5_000, maxAttempts = 5, jitterFactor = 0.3 } = config;

  let stopped = false;
  let attempt = 0;
  let lastEventId: string | undefined;
  let currentTimer: ReturnType<typeof setTimeout> | undefined;

  function computeDelay(attemptNum: number): number {
    const base = Math.min(initialDelayMs * 2 ** attemptNum, maxDelayMs);
    const jitter = base * jitterFactor * Math.random();
    return base + jitter;
  }

  async function connect(): Promise<void> {
    if (stopped) return;

    try {
      const response = await fetcher(lastEventId);

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }

      // Connection succeeded — notify and reset retry counter
      callbacks.onStatus({ kind: "connected" });
      attempt = 0;

      const parser = await consumeSSEStream(response, {
        onEvent: (event) => {
          if (event.id !== "") {
            lastEventId = event.id;
          }
          callbacks.onEvent(event);
        },
      });

      // Stream ended normally — save last id and reconnect
      if (parser.lastId !== "") {
        lastEventId = parser.lastId;
      }
    } catch {
      // Connection or stream error — fall through to retry
    }

    // Reconnect unless stopped
    if (!stopped) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    attempt++;
    if (attempt > maxAttempts) {
      callbacks.onStatus({ kind: "failed", attempt });
      return;
    }

    callbacks.onStatus({
      kind: "reconnecting",
      attempt,
      maxAttempts,
    });

    const delay = computeDelay(attempt - 1);
    currentTimer = setTimeout(() => {
      connect().catch(() => {
        /* intentional: errors handled inside connect() */
      });
    }, delay);
  }

  // Start initial connection
  connect().catch(() => {
    /* intentional: errors handled inside connect() */
  });

  return {
    stop: () => {
      stopped = true;
      if (currentTimer !== undefined) {
        clearTimeout(currentTimer);
      }
    },
    resetRetries: () => {
      attempt = 0;
    },
  };
}
