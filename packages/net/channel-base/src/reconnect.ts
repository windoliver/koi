/**
 * Reconnection manager for channel adapters.
 *
 * Manages automatic reconnection with exponential backoff using
 * computeBackoff() from @koi/errors. Resets the attempt counter
 * on successful connection.
 */

import type { RetryConfig } from "@koi/errors";
import { computeBackoff, DEFAULT_RETRY_CONFIG, sleep } from "@koi/errors";

export interface ReconnectorConfig {
  /** Establishes the platform connection. Throws on failure. */
  readonly connect: () => Promise<void>;
  /** Called after a successful (re)connection. */
  readonly onConnected: () => void;
  /** Called when the connection drops before a reconnection attempt. */
  readonly onDisconnected: () => void;
  /** Called when all retry attempts are exhausted. */
  readonly onGiveUp: (lastError: unknown) => void;
  /** Retry configuration. Defaults to DEFAULT_RETRY_CONFIG. */
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
  readonly reconnect: () => void;
}

/**
 * Creates a reconnection manager that wraps a connect() function
 * with exponential backoff retry logic.
 */
export function createReconnector(config: ReconnectorConfig): Reconnector {
  const retryConfig = config.retry ?? DEFAULT_RETRY_CONFIG;

  // let justified: mutable reconnection state
  let connected = false;
  let stopped = false;
  let attempt = 0;

  const tryConnect = async (): Promise<void> => {
    while (!stopped && attempt <= retryConfig.maxRetries) {
      try {
        await config.connect();
        connected = true;
        attempt = 0;
        config.onConnected();
        return;
      } catch (error: unknown) {
        connected = false;

        if (stopped) return;

        if (attempt >= retryConfig.maxRetries) {
          config.onGiveUp(error);
          return;
        }

        const delay = computeBackoff(attempt, retryConfig);
        attempt += 1;
        await sleep(delay);
      }
    }
  };

  return {
    start: async (): Promise<void> => {
      stopped = false;
      attempt = 0;
      await tryConnect();
    },

    stop: (): void => {
      stopped = true;
      connected = false;
    },

    isConnected: (): boolean => connected,

    reconnect: (): void => {
      if (stopped) return;
      connected = false;
      config.onDisconnected();
      void tryConnect();
    },
  };
}
