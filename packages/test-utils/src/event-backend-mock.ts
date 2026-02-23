/**
 * Mock EventBackend for downstream testing.
 *
 * Records all operations for assertion. No real subscription delivery.
 */

import type {
  DeadLetterEntry,
  DeadLetterFilter,
  EventBackend,
  EventEnvelope,
  EventInput,
  KoiError,
  ReadOptions,
  ReadResult,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";

export interface MockEventBackend extends EventBackend {
  /** All events successfully appended. */
  readonly appendedEvents: () => readonly EventEnvelope[];
  /** Active subscription names. */
  readonly activeSubscriptions: () => readonly string[];
  /** All dead-letter entries. */
  readonly deadLetterEntries: () => readonly DeadLetterEntry[];
}

/**
 * Create a mock EventBackend that records operations.
 *
 * Append works (stores in memory), subscribe is a no-op, DLQ is empty.
 * Use for testing code that *depends on* an EventBackend without needing
 * real subscription delivery.
 */
export function createMockEventBackend(): MockEventBackend {
  const events: EventEnvelope[] = [];
  const subscriptions: string[] = [];
  const deadLetters: DeadLetterEntry[] = [];
  const sequences = new Map<string, number>();

  function nextSequence(streamId: string): number {
    const current = sequences.get(streamId) ?? 0;
    const next = current + 1;
    sequences.set(streamId, next);
    return next;
  }

  return {
    appendedEvents: () => [...events],
    activeSubscriptions: () => [...subscriptions],
    deadLetterEntries: () => [...deadLetters],

    append(streamId: string, event: EventInput): Result<EventEnvelope, KoiError> {
      const envelope: EventEnvelope = {
        id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        streamId,
        type: event.type,
        timestamp: Date.now(),
        sequence: nextSequence(streamId),
        data: event.data,
        metadata: event.metadata,
      };
      events.push(envelope);
      return { ok: true, value: envelope };
    },

    read(streamId: string, options?: ReadOptions): Result<ReadResult, KoiError> {
      const streamEvents = events.filter((e) => e.streamId === streamId);
      const from = options?.fromSequence ?? 1;
      const to = options?.toSequence ?? Number.MAX_SAFE_INTEGER;
      const filtered = streamEvents.filter((e) => e.sequence >= from && e.sequence < to);
      const limit = options?.limit ?? filtered.length;
      const sliced = filtered.slice(0, limit);
      return {
        ok: true,
        value: { events: sliced, hasMore: sliced.length < filtered.length },
      };
    },

    subscribe(options: SubscribeOptions): SubscriptionHandle {
      subscriptions.push(options.subscriptionName);
      return {
        subscriptionName: options.subscriptionName,
        streamId: options.streamId,
        unsubscribe: () => {
          const idx = subscriptions.indexOf(options.subscriptionName);
          if (idx >= 0) subscriptions.splice(idx, 1);
        },
        position: () => 0,
      };
    },

    queryDeadLetters(_filter?: DeadLetterFilter): Result<readonly DeadLetterEntry[], KoiError> {
      return { ok: true, value: [...deadLetters] };
    },

    retryDeadLetter(_entryId: string): Result<boolean, KoiError> {
      return { ok: true, value: false };
    },

    purgeDeadLetters(_filter?: DeadLetterFilter): Result<void, KoiError> {
      deadLetters.length = 0;
      return { ok: true, value: undefined };
    },

    streamLength(streamId: string): number {
      return events.filter((e) => e.streamId === streamId).length;
    },

    firstSequence(streamId: string): number {
      const streamEvents = events.filter((e) => e.streamId === streamId);
      return streamEvents.length > 0 ? (streamEvents[0]?.sequence ?? 0) : 0;
    },

    close(): void {
      // No-op for mock
    },
  };
}
