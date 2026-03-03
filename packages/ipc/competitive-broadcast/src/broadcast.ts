/**
 * Broadcast sinks for delivering competitive selection results.
 *
 * Two built-in implementations:
 * - InMemoryBroadcastSink: calls recipient callbacks in parallel
 * - EventBroadcastSink: emits to an EventComponent event bus
 */

import type { BroadcastReport, BroadcastResult, BroadcastSink } from "./types.js";

// ---------------------------------------------------------------------------
// Recipient callback type
// ---------------------------------------------------------------------------

/** Async callback invoked with the broadcast result. */
export type BroadcastRecipient = (result: BroadcastResult) => Promise<void>;

// ---------------------------------------------------------------------------
// createInMemoryBroadcastSink
// ---------------------------------------------------------------------------

/**
 * Creates a BroadcastSink that calls each recipient callback in parallel
 * via Promise.allSettled. Never throws — failures are counted in the report.
 */
export function createInMemoryBroadcastSink(
  recipients: readonly BroadcastRecipient[],
): BroadcastSink {
  return {
    broadcast: async (result: BroadcastResult): Promise<BroadcastReport> => {
      if (recipients.length === 0) {
        return { delivered: 0, failed: 0 };
      }

      const settled = await Promise.allSettled(recipients.map((r) => r(result)));

      const errors: unknown[] = [];
      /* let is required for accumulator */
      let delivered = 0;

      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          delivered++;
        } else {
          errors.push(outcome.reason);
        }
      }

      return {
        delivered,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createEventBroadcastSink
// ---------------------------------------------------------------------------

/** Minimal EventComponent shape needed by the event sink. */
export interface EventComponentLike {
  readonly emit: (type: string, data: unknown) => Promise<void>;
}

/**
 * Creates a BroadcastSink that emits a "broadcast:winner" event
 * to an EventComponent. Single recipient (the event bus).
 */
export function createEventBroadcastSink(eventComponent: EventComponentLike): BroadcastSink {
  return {
    broadcast: async (result: BroadcastResult): Promise<BroadcastReport> => {
      try {
        await eventComponent.emit("broadcast:winner", result);
        return { delivered: 1, failed: 0 };
      } catch (e: unknown) {
        return { delivered: 0, failed: 1, errors: [e] };
      }
    },
  };
}
