/**
 * Shared subscription delivery chain for EventBackend implementations.
 *
 * Manages subscriptions, serialized event delivery, retry, dead letter queue,
 * and replay. Backend implementations provide callbacks for persistence.
 */

import type {
  DeadLetterEntry,
  DeadLetterFilter,
  EventEnvelope,
  KoiError,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";
import { internal, notFound } from "@koi/core";
import { generateUlid } from "@koi/hash";

// ---------------------------------------------------------------------------
// Callback interface — backend provides persistence
// ---------------------------------------------------------------------------

export interface DeliveryCallbacks {
  /** Persist subscription position (no-op for in-memory backends). */
  readonly persistPosition: (subscriptionName: string, sequence: number) => void | Promise<void>;
  /** Persist a dead letter entry. */
  readonly persistDeadLetter: (entry: DeadLetterEntry) => void | Promise<void>;
  /** Read events from a stream starting after the given sequence. */
  readonly readStream: (
    streamId: string,
    fromSequence: number,
  ) => readonly EventEnvelope[] | Promise<readonly EventEnvelope[]>;
  /** Remove a dead letter entry by id. Returns true if removed. */
  readonly removeDeadLetter: (entryId: string) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default maximum in-memory dead letter entries before FIFO eviction. */
const DEFAULT_MAX_DEAD_LETTERS = 1_000;

export interface DeliveryConfig {
  /** Max in-memory dead letter entries. Oldest evicted first. Default: 1000. */
  readonly maxDeadLetters?: number | undefined;
}

// ---------------------------------------------------------------------------
// Delivery manager interface
// ---------------------------------------------------------------------------

export interface DeliveryManager {
  /** Register a new subscription and start replay. */
  readonly subscribe: (options: SubscribeOptions) => SubscriptionHandle;
  /** Notify all active subscriptions for a stream of a new event. */
  readonly notifySubscribers: (streamId: string, event: EventEnvelope) => void;
  /** Query dead letter entries (delegated to in-memory tracking or backend). */
  readonly queryDeadLetters: (
    filter?: DeadLetterFilter,
  ) => Result<readonly DeadLetterEntry[], KoiError>;
  /** Retry a dead-lettered event. */
  readonly retryDeadLetter: (
    entryId: string,
  ) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  /** Purge dead letter entries matching filter. */
  readonly purgeDeadLetters: (filter?: DeadLetterFilter) => Result<void, KoiError>;
  /** Deactivate all subscriptions. */
  readonly closeAll: () => void;
}

// ---------------------------------------------------------------------------
// Internal subscription state
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

/** Create a delivery manager that delegates persistence to the provided callbacks. */
export function createDeliveryManager(
  callbacks: DeliveryCallbacks,
  config?: DeliveryConfig,
): DeliveryManager {
  const maxDeadLetters = config?.maxDeadLetters ?? DEFAULT_MAX_DEAD_LETTERS;
  const subscriptions = new Map<string, SubscriptionState>();
  const deadLetters: DeadLetterEntry[] = [];

  // -------------------------------------------------------------------------
  // Delivery internals
  // -------------------------------------------------------------------------

  /** Check if an event matches a subscription's type filter. */
  function matchesTypeFilter(
    event: EventEnvelope,
    types: ReadonlySet<string> | undefined,
  ): boolean {
    if (types === undefined) return true;
    return types.has(event.type);
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
        await callbacks.persistPosition(sub.subscriptionName, event.sequence);
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
          // FIFO eviction: drop oldest entries when cap is exceeded
          while (deadLetters.length > maxDeadLetters) {
            deadLetters.shift();
          }
          await callbacks.persistDeadLetter(dlEntry);
          sub.onDeadLetter?.(dlEntry);
          // Advance position past the failed event to avoid re-delivery loop
          sub.position = event.sequence;
          await callbacks.persistPosition(sub.subscriptionName, event.sequence);
          return;
        }
        // Immediate retry (no backoff)
      }
    }
  }

  /**
   * Enqueue event delivery to a subscription's serialized chain.
   * Ensures events are delivered in strict sequence order even with async handlers.
   * Events not matching the type filter still advance position but skip the handler.
   */
  function enqueueDelivery(sub: SubscriptionState, event: EventEnvelope): void {
    sub.deliveryChain = sub.deliveryChain
      .then(async () => {
        if (!sub.active) return;
        if (!matchesTypeFilter(event, sub.types)) {
          // Skip delivery but advance position so we don't re-see this event
          sub.position = event.sequence;
          await callbacks.persistPosition(sub.subscriptionName, event.sequence);
          return;
        }
        return deliverToSubscription(sub, event);
      })
      .catch((err: unknown) => {
        // Keep the chain alive for subsequent events. deliverToSubscription
        // handles its own retry/DLQ errors — this catch prevents chain breakage.
        console.warn(
          "[event-delivery] unexpected delivery failure:",
          err instanceof Error ? err.message : err,
        );
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
    // Queue replay as async operation in the delivery chain
    sub.deliveryChain = sub.deliveryChain
      .then(async () => {
        const events = await callbacks.readStream(sub.streamId, sub.position);
        for (const event of events) {
          if (!sub.active) return;
          if (!matchesTypeFilter(event, sub.types)) {
            sub.position = event.sequence;
            await callbacks.persistPosition(sub.subscriptionName, event.sequence);
            continue;
          }
          await deliverToSubscription(sub, event);
        }
      })
      .catch((err: unknown) => {
        // Prevent chain breakage during replay
        console.warn(
          "[event-delivery] unexpected replay failure:",
          err instanceof Error ? err.message : err,
        );
      });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const subscribe = (options: SubscribeOptions): SubscriptionHandle => {
    const fromPos = options.fromPosition ?? Number.MAX_SAFE_INTEGER;
    const maxRetries = Math.max(1, options.maxRetries ?? 3);
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
  };

  const queryDeadLetters = (
    filter?: DeadLetterFilter,
  ): Result<readonly DeadLetterEntry[], KoiError> => {
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
  };

  const retryDeadLetter = (
    entryId: string,
  ): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>> => {
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
      void callbacks.removeDeadLetter(entryId);
      return { ok: true, value: false };
    }

    // Remove from DLQ
    deadLetters.splice(idx, 1);
    void callbacks.removeDeadLetter(entryId);

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
  };

  const purgeDeadLetters = (filter?: DeadLetterFilter): Result<void, KoiError> => {
    if (filter === undefined) {
      deadLetters.length = 0;
      return { ok: true, value: undefined };
    }

    // Remove matching entries in reverse to maintain indices
    for (let i = deadLetters.length - 1; i >= 0; i--) {
      const entry = deadLetters[i];
      if (entry === undefined) continue;
      const matchStream = filter.streamId === undefined || entry.event.streamId === filter.streamId;
      const matchSub =
        filter.subscriptionName === undefined || entry.subscriptionName === filter.subscriptionName;
      if (matchStream && matchSub) {
        deadLetters.splice(i, 1);
      }
    }

    return { ok: true, value: undefined };
  };

  const closeAll = (): void => {
    for (const sub of subscriptions.values()) {
      sub.active = false;
    }
    subscriptions.clear();
  };

  return {
    subscribe,
    notifySubscribers,
    queryDeadLetters,
    retryDeadLetter,
    purgeDeadLetters,
    closeAll,
  };
}
