/**
 * In-memory RetrySignalBroker implementation.
 *
 * Trivial Map-based broker for cross-middleware retry coordination.
 * Created by the L3 runtime compose layer and injected into both
 * semantic-retry (writer) and event-trace (reader).
 */

import type { RetrySignal, RetrySignalBroker } from "@koi/core/retry-signal";

/** Create an in-memory RetrySignalBroker instance. */
export function createRetrySignalBroker(): RetrySignalBroker {
  const signals = new Map<string, RetrySignal>();
  return {
    setRetrySignal(sessionId: string, signal: RetrySignal): void {
      signals.set(sessionId, signal);
    },
    clearRetrySignal(sessionId: string): void {
      signals.delete(sessionId);
    },
    getRetrySignal(sessionId: string): RetrySignal | undefined {
      return signals.get(sessionId);
    },
  };
}
