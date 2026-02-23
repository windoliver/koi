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
  DeadLetterEntry,
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
import { internal, notFound, validation } from "@koi/core";
import { generateUlid } from "@koi/hash";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal mutable subscription state. Not exposed to consumers.
 * `position`, `active`, and `deliveryChain` are intentionally non-readonly
 * as they are mutated during delivery and lifecycle management.
 */
interface SubscriptionState {
  readonly streamId: string;
  readonly subscriptionName: string;
  readonly handler: (event: EventEnvelope) => void | Promise<void>;
  readonly maxRetries: number;
  readonly onDeadLetter?: ((entry: DeadLetterEntry) => void) | undefined;
  readonly types?: ReadonlySet<string> | undefined;
  /** Mutable: last successfully processed sequence. */
  position: number;
  /** Mutable: whether subscription is active. */
  active: boolean;
  /** Mutable: serialized delivery chain — ensures in-order event processing. */
  deliveryChain: Promise<void>;
}

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
  // Active subscriptions keyed by subscriptionName
  const subscriptions = new Map<string, SubscriptionState>();
  // Dead letter entries
  const deadLetters: DeadLetterEntry[] = [];

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

  async function deliverToSubscription(
    sub: SubscriptionState,
    event: EventEnvelope,
  ): Promise<void> {
    // let is required: attempt counter mutates in retry loop
    let attempts = 0;
    while (attempts < sub.maxRetries) {
      attempts++;
      try {
        await sub.handler(event);
        // Success — advance position
        sub.position = event.sequence;
        return;
      } catch (err: unknown) {
        if (attempts >= sub.maxRetries) {
          // Dead-letter the event
          const dlEntry: DeadLetterEntry = {
            id: generateUlid(),
            event,
            subscriptionName: sub.subscriptionName,
            error: err instanceof Error ? err.message : String(err),
            attempts,
            deadLetteredAt: Date.now(),
          };
          deadLetters.push(dlEntry);
          sub.onDeadLetter?.(dlEntry);
          // Advance position past the failed event to avoid re-delivery loop
          sub.position = event.sequence;
          return;
        }
        // Immediate retry (no backoff for in-memory backend)
      }
    }
  }

  /** Check if an event matches a subscription's type filter. */
  function matchesTypeFilter(
    event: EventEnvelope,
    types: ReadonlySet<string> | undefined,
  ): boolean {
    if (types === undefined) return true;
    return types.has(event.type);
  }

  /**
   * Enqueue event delivery to a subscription's serialized chain.
   * Ensures events are delivered in strict sequence order even with async handlers.
   * Events not matching the type filter still advance position but skip the handler.
   */
  function enqueueDelivery(sub: SubscriptionState, event: EventEnvelope): void {
    sub.deliveryChain = sub.deliveryChain
      .then(() => {
        if (!sub.active) return;
        if (!matchesTypeFilter(event, sub.types)) {
          // Skip delivery but advance position so we don't re-see this event
          sub.position = event.sequence;
          return;
        }
        return deliverToSubscription(sub, event);
      })
      .catch(() => {
        // Guard against unexpected failures (e.g. ULID generation) to keep
        // the chain alive for subsequent events. deliverToSubscription handles
        // its own retry/DLQ errors — this catch prevents chain breakage only.
      });
  }

  function notifySubscribers(streamId: string, event: EventEnvelope): void {
    for (const sub of subscriptions.values()) {
      if (sub.streamId === streamId && sub.active) {
        enqueueDelivery(sub, event);
      }
    }
  }

  function replayToSubscription(sub: SubscriptionState): void {
    const stream = streams.get(sub.streamId);
    if (stream === undefined) return;

    // Find events after the subscription's current position
    const pending = stream.filter((e) => e.sequence > sub.position);
    for (const event of pending) {
      enqueueDelivery(sub, event);
    }
  }

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
        notifySubscribers(streamId, envelope);

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
      const fromPos = options.fromPosition ?? Number.MAX_SAFE_INTEGER;
      const maxRetries = options.maxRetries ?? 3;
      const types = options.types !== undefined ? new Set(options.types) : undefined;

      const sub: SubscriptionState = {
        streamId: options.streamId,
        subscriptionName: options.subscriptionName,
        handler: options.handler,
        maxRetries,
        onDeadLetter: options.onDeadLetter,
        types,
        position: fromPos,
        active: true,
        deliveryChain: Promise.resolve(),
      };

      subscriptions.set(options.subscriptionName, sub);

      // Replay any existing events after the position
      replayToSubscription(sub);

      return {
        subscriptionName: options.subscriptionName,
        streamId: options.streamId,
        unsubscribe: () => {
          sub.active = false;
          subscriptions.delete(options.subscriptionName);
        },
        position: () => sub.position,
      };
    },

    queryDeadLetters(filter?: DeadLetterFilter): Result<readonly DeadLetterEntry[], KoiError> {
      // let is required: result is progressively filtered
      let result: readonly DeadLetterEntry[] = deadLetters;

      if (filter?.streamId !== undefined) {
        const sid = filter.streamId;
        result = result.filter((e) => e.event.streamId === sid);
      }
      if (filter?.subscriptionName !== undefined) {
        const sn = filter.subscriptionName;
        result = result.filter((e) => e.subscriptionName === sn);
      }
      if (filter?.limit !== undefined) {
        result = result.slice(0, filter.limit);
      }

      return { ok: true, value: result };
    },

    retryDeadLetter(
      entryId: string,
    ): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>> {
      const idx = deadLetters.findIndex((e) => e.id === entryId);
      if (idx < 0) {
        return { ok: false, error: notFound(entryId, `Dead letter entry not found: ${entryId}`) };
      }
      const entry = deadLetters[idx];
      if (entry === undefined) {
        return { ok: false, error: notFound(entryId, `Dead letter entry not found: ${entryId}`) };
      }
      const sub = subscriptions.get(entry.subscriptionName);
      if (sub === undefined || !sub.active) {
        // Subscription no longer active — still remove from DLQ
        deadLetters.splice(idx, 1);
        return { ok: true, value: false };
      }

      // Remove from DLQ
      deadLetters.splice(idx, 1);

      // Re-deliver via serialized chain
      return new Promise<Result<boolean, KoiError>>((resolve) => {
        sub.deliveryChain = sub.deliveryChain
          .then(() => deliverToSubscription(sub, entry.event))
          .then(() => {
            resolve({ ok: true, value: true });
          })
          .catch((err: unknown) => {
            resolve({ ok: false, error: internal("Failed to retry dead letter", err) });
          });
      });
    },

    purgeDeadLetters(filter?: DeadLetterFilter): Result<void, KoiError> {
      if (filter === undefined) {
        deadLetters.length = 0;
        return { ok: true, value: undefined };
      }

      // Remove matching entries in reverse to maintain indices
      for (let i = deadLetters.length - 1; i >= 0; i--) {
        const entry = deadLetters[i];
        if (entry === undefined) continue;
        const matchStream =
          filter.streamId === undefined || entry.event.streamId === filter.streamId;
        const matchSub =
          filter.subscriptionName === undefined ||
          entry.subscriptionName === filter.subscriptionName;
        if (matchStream && matchSub) {
          deadLetters.splice(i, 1);
        }
      }

      return { ok: true, value: undefined };
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
      // Deactivate all subscriptions
      for (const sub of subscriptions.values()) {
        sub.active = false;
      }
      subscriptions.clear();
      streams.clear();
      sequences.clear();
      deadLetters.length = 0;
    },
  };

  return backend;
}
