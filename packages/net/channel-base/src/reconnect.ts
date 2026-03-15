/**
 * Reconnection manager for channel adapters.
 *
 * Manages automatic reconnection with exponential backoff using
 * computeBackoff() from @koi/errors. Resets the attempt counter
 * on successful connection. Supports decorrelated jitter via
 * DEFAULT_RECONNECT_CONFIG and infinite retries via maxRetries: Infinity.
 */

import type { RetryConfig } from "@koi/errors";
import { computeBackoff, DEFAULT_RECONNECT_CONFIG, sleep } from "@koi/errors";

/** Structured disconnect reason surfaced to callbacks. */
export interface DisconnectInfo {
  readonly code?: number;
  readonly reason?: string;
}

export interface ReconnectorConfig {
  /** Establishes the platform connection. Throws on failure. */
  readonly connect: () => Promise<void>;
  /** Called after a successful (re)connection. */
  readonly onConnected: () => void;
  /** Called when the connection drops before a reconnection attempt. */
  readonly onDisconnected: (info?: DisconnectInfo) => void;
  /** Called when all retry attempts are exhausted. */
  readonly onGiveUp: (lastError: unknown, info?: DisconnectInfo) => void;
  /** Retry configuration. Defaults to DEFAULT_RECONNECT_CONFIG. */
  readonly retry?: RetryConfig;
}

export interface Reconnector {
  /** Starts the reconnection loop. Resolves after first successful connect. */
  readonly start: () => Promise<void>;
  /** Stops the reconnection loop and prevents further attempts. */
  readonly stop: () => void;
  /** Returns true if currently connected. */
  readonly isConnected: () => boolean;
  /** Triggers a reconnection attempt (e.g., on connection drop). */
  readonly reconnect: (info?: DisconnectInfo) => void;
  /** Returns the current retry attempt count. */
  readonly attempts: () => number;
}

/**
 * Creates a reconnection manager that wraps a connect() function
 * with exponential backoff retry logic.
 */
export function createReconnector(config: ReconnectorConfig): Reconnector {
  const retryConfig = config.retry ?? DEFAULT_RECONNECT_CONFIG;
  const infiniteRetries = !Number.isFinite(retryConfig.maxRetries);

  // let justified: mutable reconnection state
  let connected = false;
  let stopped = false;
  let attempt = 0;
  // let justified: tracks previous delay for decorrelated jitter
  let prevDelay = 0;

  const tryConnect = async (disconnectInfo?: DisconnectInfo): Promise<void> => {
    while (!stopped && (infiniteRetries || attempt <= retryConfig.maxRetries)) {
      try {
        await config.connect();
        connected = true;
        attempt = 0;
        prevDelay = 0;
        config.onConnected();
        return;
      } catch (error: unknown) {
        connected = false;

        if (stopped) return;

        if (!infiniteRetries && attempt >= retryConfig.maxRetries) {
          config.onGiveUp(error, disconnectInfo);
          return;
        }

        const delay = computeBackoff(attempt, retryConfig, undefined, undefined, prevDelay);
        prevDelay = delay;
        attempt += 1;
        await sleep(delay);
      }
    }
  };

  return {
    start: async (): Promise<void> => {
      stopped = false;
      attempt = 0;
      prevDelay = 0;
      await tryConnect();
    },

    stop: (): void => {
      stopped = true;
      connected = false;
    },

    isConnected: (): boolean => connected,

    reconnect: (info?: DisconnectInfo): void => {
      if (stopped) return;
      connected = false;
      config.onDisconnected(info);
      void tryConnect(info);
    },

    attempts: (): number => attempt,
  };
}
