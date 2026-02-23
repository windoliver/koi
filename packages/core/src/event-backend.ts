/**
 * Event backend contract — L0 types for durable event infrastructure.
 *
 * Defines the pluggable event backend with real-time subscriptions,
 * event replay from checkpoint, and dead letter queue for failed deliveries.
 *
 * Stream-based model: events belong to named streams (e.g., "agent:<id>"),
 * each with its own monotonically increasing sequence numbers.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Event envelope — the immutable record stored in a stream
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  /** Globally unique, time-sortable event ID (ULID). */
  readonly id: string;
  /** Stream this event belongs to (e.g., "agent:<id>", "brick:<id>"). */
  readonly streamId: string;
  /** Event type discriminator (e.g., "agent:state_changed"). */
  readonly type: string;
  /** Unix timestamp ms when the event was appended. */
  readonly timestamp: number;
  /** Per-stream position — 1-based, monotonically increasing. May have gaps after FIFO eviction. */
  readonly sequence: number;
  /** Event payload. */
  readonly data: unknown;
  /** Optional structured metadata (e.g., correlationId, causationId). */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Event input — what callers provide to append()
// ---------------------------------------------------------------------------

export interface EventInput {
  /** Event type discriminator. */
  readonly type: string;
  /** Event payload. */
  readonly data: unknown;
  /** Optional structured metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Read options — batch read with pagination
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /** Inclusive start sequence (default: 1). */
  readonly fromSequence?: number | undefined;
  /** Exclusive end sequence. */
  readonly toSequence?: number | undefined;
  /** Maximum events to return. */
  readonly limit?: number | undefined;
  /** Read direction (default: "forward"). */
  readonly direction?: "forward" | "backward" | undefined;
  /** Filter by event types. Only events matching one of these types are returned. */
  readonly types?: readonly string[] | undefined;
}

export interface ReadResult {
  /** Events matching the read options. */
  readonly events: readonly EventEnvelope[];
  /** True if more events exist beyond the returned batch. */
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Subscription — real-time delivery with durable position tracking
// ---------------------------------------------------------------------------

export interface SubscribeOptions {
  /** Stream to subscribe to. */
  readonly streamId: string;
  /** Durable subscription name — position tracked by this name. */
  readonly subscriptionName: string;
  /** Resume from this sequence (default: latest — only new events). */
  readonly fromPosition?: number | undefined;
  /** Handler called for each event. Throw to trigger retry + DLQ. */
  readonly handler: (event: EventEnvelope) => void | Promise<void>;
  /** Max delivery attempts before dead-lettering (default: 3). */
  readonly maxRetries?: number | undefined;
  /** Called when an event is dead-lettered. */
  readonly onDeadLetter?: ((entry: DeadLetterEntry) => void) | undefined;
  /** Filter by event types. Only events matching one of these types are delivered. */
  readonly types?: readonly string[] | undefined;
}

export interface SubscriptionHandle {
  /** The durable subscription name. */
  readonly subscriptionName: string;
  /** The stream being subscribed to. */
  readonly streamId: string;
  /** Stop receiving events. */
  readonly unsubscribe: () => void;
  /** Current cursor position (last successfully processed sequence). */
  readonly position: () => number;
}

// ---------------------------------------------------------------------------
// Dead letter queue — failed event deliveries
// ---------------------------------------------------------------------------

export interface DeadLetterEntry {
  /** Unique DLQ entry ID. */
  readonly id: string;
  /** The event that failed delivery. */
  readonly event: EventEnvelope;
  /** Subscription that failed to process this event. */
  readonly subscriptionName: string;
  /** Error message from the last failed attempt. */
  readonly error: string;
  /** Total delivery attempts before dead-lettering. */
  readonly attempts: number;
  /** Unix timestamp ms when the event was dead-lettered. */
  readonly deadLetteredAt: number;
}

export interface DeadLetterFilter {
  /** Filter by stream. */
  readonly streamId?: string | undefined;
  /** Filter by subscription name. */
  readonly subscriptionName?: string | undefined;
  /** Maximum entries to return. */
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Backend configuration
// ---------------------------------------------------------------------------

export interface EventBackendConfig {
  /** Max events per stream before FIFO eviction (default: 10_000). */
  readonly maxEventsPerStream?: number | undefined;
  /** Time-to-live for events in ms. Expired events are excluded from reads. */
  readonly eventTtlMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// EventBackend — the main contract
// ---------------------------------------------------------------------------

/**
 * Pluggable event backend with persistence, replay, subscriptions, and DLQ.
 *
 * All fallible operations return `Result<T, KoiError>`.
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * database/network implementations are async. Callers must always `await`.
 */
export interface EventBackend {
  /** Append an event to a stream. Returns the full envelope with assigned id + sequence. */
  readonly append: (
    streamId: string,
    event: EventInput,
  ) => Result<EventEnvelope, KoiError> | Promise<Result<EventEnvelope, KoiError>>;

  /** Read events from a stream (batch, paginated). */
  readonly read: (
    streamId: string,
    options?: ReadOptions,
  ) => Result<ReadResult, KoiError> | Promise<Result<ReadResult, KoiError>>;

  /** Subscribe to a stream for real-time delivery with durable position tracking. */
  readonly subscribe: (
    options: SubscribeOptions,
  ) => SubscriptionHandle | Promise<SubscriptionHandle>;

  /** Query dead-lettered events. */
  readonly queryDeadLetters: (
    filter?: DeadLetterFilter,
  ) =>
    | Result<readonly DeadLetterEntry[], KoiError>
    | Promise<Result<readonly DeadLetterEntry[], KoiError>>;

  /** Retry a dead-lettered event (re-deliver to its subscription handler). */
  readonly retryDeadLetter: (
    entryId: string,
  ) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;

  /** Purge dead-lettered entries matching an optional filter. */
  readonly purgeDeadLetters: (
    filter?: DeadLetterFilter,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /** Return the number of (non-expired) events in a stream. */
  readonly streamLength: (streamId: string) => number | Promise<number>;

  /** Return the lowest available sequence in a stream (0 if empty). Useful after FIFO eviction or TTL expiry. */
  readonly firstSequence: (streamId: string) => number | Promise<number>;

  /** Close the backend and release resources. */
  readonly close: () => void | Promise<void>;
}
