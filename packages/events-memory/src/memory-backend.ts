/**
 * In-memory EventBackend implementation.
 *
 * Provides event persistence, replay, named subscriptions with durable
 * position tracking, retry, and dead letter queue — all in-memory.
 *
 * Suitable for development, testing, and single-process deployments.
 * For durable persistence, use a database-backed implementation.
 */

import type {
  DeadLetterFilter,
  EventBackend,
  EventBackendConfig,
  EventEnvelope,
  EventInput,
  KoiError,
  ReadOptions,
  ReadResult,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";
import { conflict, internal, validation } from "@koi/core";
import { createDeliveryManager } from "@koi/event-delivery";
import { generateUlid } from "@koi/hash";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS_PER_STREAM = 10_000;

/**
 * Create an in-memory EventBackend.
 *
 * All data lives in process memory. Lost on process exit.
 * FIFO eviction keeps each stream under `maxEventsPerStream`.
 * TTL eviction excludes expired events from reads (lazy cleanup on append).
 */
export function createInMemoryEventBackend(config?: EventBackendConfig): EventBackend {
  const maxPerStream = config?.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
  const eventTtlMs = config?.eventTtlMs;

  // Per-stream event storage (internal mutable state, never exposed)
  const streams = new Map<string, EventEnvelope[]>();
  // Per-stream next sequence counter
  const sequences = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function isExpired(event: EventEnvelope, now: number): boolean {
    if (eventTtlMs === undefined) return false;
    return now - event.timestamp > eventTtlMs;
  }

  function getOrCreateStream(streamId: string): EventEnvelope[] {
    const existing = streams.get(streamId);
    if (existing !== undefined) return existing;
    const stream: EventEnvelope[] = [];
    streams.set(streamId, stream);
    return stream;
  }

  function nextSequence(streamId: string): number {
    const current = sequences.get(streamId) ?? 0;
    const next = current + 1;
    sequences.set(streamId, next);
    return next;
  }

  function evictIfNeeded(stream: EventEnvelope[]): void {
    // TTL eviction — batch-remove expired events from the front in a single splice
    if (eventTtlMs !== undefined) {
      const now = Date.now();
      // let is required: scanning forward for first non-expired index
      let firstLive = 0;
      while (firstLive < stream.length) {
        const event = stream[firstLive];
        if (event === undefined || !isExpired(event, now)) break;
        firstLive++;
      }
      if (firstLive > 0) {
        stream.splice(0, firstLive);
      }
    }
    // FIFO eviction — single splice to cap stream length
    const excess = stream.length - maxPerStream;
    if (excess > 0) {
      stream.splice(0, excess);
    }
  }

  /** Get non-expired events from a stream. */
  function liveEvents(stream: readonly EventEnvelope[]): readonly EventEnvelope[] {
    if (eventTtlMs === undefined) return stream;
    const now = Date.now();
    return stream.filter((e) => !isExpired(e, now));
  }

  // -------------------------------------------------------------------------
  // Delivery manager — delegates to in-memory storage
  // -------------------------------------------------------------------------

  const delivery = createDeliveryManager({
    persistPosition: () => {
      // No-op for in-memory backend — position tracked in delivery manager state
    },
    persistDeadLetter: () => {
      // No-op — delivery manager maintains in-memory DLQ
    },
    readStream: (streamId, fromSequence) => {
      const stream = streams.get(streamId);
      if (stream === undefined) return [];
      return stream.filter((e) => e.sequence > fromSequence);
    },
    removeDeadLetter: () => true,
  });

  // -------------------------------------------------------------------------
  // EventBackend implementation
  // -------------------------------------------------------------------------

  const backend: EventBackend = {
    append(streamId: string, event: EventInput): Result<EventEnvelope, KoiError> {
      if (streamId === "") {
        return { ok: false, error: validation("streamId must not be empty") };
      }
      if (event.type === "") {
        return { ok: false, error: validation("event type must not be empty") };
      }

      // Optimistic concurrency check
      if (event.expectedSequence !== undefined) {
        const currentLen = sequences.get(streamId) ?? 0;
        if (currentLen !== event.expectedSequence) {
          return {
            ok: false,
            error: conflict(
              streamId,
              `Stream "${streamId}" sequence mismatch: expected ${String(event.expectedSequence)}, current is ${String(currentLen)}`,
            ),
          };
        }
      }

      try {
        const stream = getOrCreateStream(streamId);
        const seq = nextSequence(streamId);
        const envelope: EventEnvelope = {
          id: generateUlid(),
          streamId,
          type: event.type,
          timestamp: Date.now(),
          sequence: seq,
          data: event.data,
          metadata: event.metadata,
        };

        stream.push(envelope);
        evictIfNeeded(stream);
        delivery.notifySubscribers(streamId, envelope);

        return { ok: true, value: envelope };
      } catch (err: unknown) {
        return { ok: false, error: internal("Failed to append event", err) };
      }
    },

    read(streamId: string, options?: ReadOptions): Result<ReadResult, KoiError> {
      const stream = streams.get(streamId) ?? [];
      const live = liveEvents(stream);
      const from = options?.fromSequence ?? 1;
      const to = options?.toSequence ?? Number.MAX_SAFE_INTEGER;
      const direction = options?.direction ?? "forward";
      const limit = options?.limit;
      const typeFilter = options?.types !== undefined ? new Set(options.types) : undefined;

      // let is required: filtered is progressively narrowed
      let filtered = live.filter((e) => e.sequence >= from && e.sequence < to);

      if (typeFilter !== undefined) {
        filtered = filtered.filter((e) => typeFilter.has(e.type));
      }

      const ordered = direction === "backward" ? filtered.toReversed() : filtered;

      if (limit !== undefined && limit < ordered.length) {
        return {
          ok: true,
          value: { events: ordered.slice(0, limit), hasMore: true },
        };
      }

      return {
        ok: true,
        value: { events: ordered, hasMore: false },
      };
    },

    subscribe(options: SubscribeOptions): SubscriptionHandle {
      return delivery.subscribe(options);
    },

    queryDeadLetters(filter?: DeadLetterFilter) {
      return delivery.queryDeadLetters(filter);
    },

    retryDeadLetter(entryId: string) {
      return delivery.retryDeadLetter(entryId);
    },

    purgeDeadLetters(filter?: DeadLetterFilter) {
      return delivery.purgeDeadLetters(filter);
    },

    streamLength(streamId: string): number {
      const stream = streams.get(streamId);
      if (stream === undefined) return 0;
      if (eventTtlMs === undefined) return stream.length;
      // Inline scan: events are timestamp-ordered, so expired are at the front
      const now = Date.now();
      // let is required: scanning forward for first non-expired index
      let firstLive = 0;
      while (firstLive < stream.length) {
        const event = stream[firstLive];
        if (event === undefined || !isExpired(event, now)) break;
        firstLive++;
      }
      return stream.length - firstLive;
    },

    firstSequence(streamId: string): number {
      const stream = streams.get(streamId);
      if (stream === undefined) return 0;
      if (eventTtlMs === undefined) {
        return stream.length > 0 ? (stream[0]?.sequence ?? 0) : 0;
      }
      // Inline scan: find first non-expired event and return its sequence
      const now = Date.now();
      for (const event of stream) {
        if (!isExpired(event, now)) return event.sequence;
      }
      return 0;
    },

    close(): void {
      delivery.closeAll();
      streams.clear();
      sequences.clear();
    },
  };

  return backend;
}
