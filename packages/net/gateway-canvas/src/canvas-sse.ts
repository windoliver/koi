/**
 * SSE (Server-Sent Events) subscriber registry for canvas surfaces.
 *
 * Manages per-surface fan-out, keep-alive pings, connection limits,
 * and automatic dead-subscriber cleanup.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Monotonic event ID. Note: replay from Last-Event-ID is not supported; reconnections are live-only. */
  readonly id: string;
  /** Event type: "updated" | "deleted". */
  readonly event: string;
  /** JSON payload string. */
  readonly data: string;
}

/**
 * Callback that receives raw SSE bytes.
 * Returns false if the subscriber is dead (connection closed).
 */
export type SseSubscriber = (data: Uint8Array) => boolean;

export interface CanvasSseManager {
  /**
   * Register a subscriber for a surface's event stream.
   * Returns an unsubscribe function on success.
   * Fails with RATE_LIMIT if per-surface or global limit reached.
   */
  readonly subscribe: (
    surfaceId: string,
    subscriber: SseSubscriber,
  ) => Result<() => void, KoiError>;
  /** Fan out an event to all subscribers for a surface. */
  readonly publish: (surfaceId: string, event: SseEvent) => void;
  /** Send "deleted" event and remove all subscribers for a surface. */
  readonly close: (surfaceId: string) => void;
  /** Stop keep-alive timer and clear all subscribers. */
  readonly dispose: () => void;
  /** Get the next monotonic event ID for a surface. */
  readonly nextEventId: (surfaceId: string) => string;
  readonly subscriberCount: (surfaceId: string) => number;
  readonly totalSubscribers: () => number;
}

export interface CanvasSseConfig {
  /** Max subscribers per surface. Default: 100. */
  readonly maxSubscribersPerSurface: number;
  /** Max total subscribers across all surfaces. Default: 10_000. */
  readonly maxTotalSubscribers: number;
  /** Keep-alive interval in ms. Default: 15_000. */
  readonly keepAliveIntervalMs: number;
}

const DEFAULT_CANVAS_SSE_CONFIG: CanvasSseConfig = {
  maxSubscribersPerSurface: 100,
  maxTotalSubscribers: 10_000,
  keepAliveIntervalMs: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Strip newlines from SSE field values to prevent injection. */
function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Format an SSE event to wire format bytes. */
export function formatSseEvent(event: SseEvent): Uint8Array {
  const id = sanitizeSseField(event.id);
  const eventType = sanitizeSseField(event.event);
  // Data may contain newlines — each line must be prefixed with "data: " per SSE spec
  const dataLines = event.data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return encoder.encode(`id: ${id}\nevent: ${eventType}\n${dataLines}\n\n`);
}

const KEEP_ALIVE_BYTES = encoder.encode(": keep-alive\n\n");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCanvasSseManager(
  configOverrides?: Partial<CanvasSseConfig>,
): CanvasSseManager {
  const config: CanvasSseConfig = { ...DEFAULT_CANVAS_SSE_CONFIG, ...configOverrides };
  const registry = new Map<string, Set<SseSubscriber>>();
  const eventCounters = new Map<string, number>();
  // let: mutable counter tracking total subscribers across all surfaces
  let total = 0;

  function nextEventId(surfaceId: string): string {
    const counter = (eventCounters.get(surfaceId) ?? 0) + 1;
    eventCounters.set(surfaceId, counter);
    return String(counter);
  }

  function removeSubscriber(surfaceId: string, subscriber: SseSubscriber): void {
    const subscribers = registry.get(surfaceId);
    if (subscribers === undefined) return;
    if (subscribers.delete(subscriber)) {
      total--;
      if (subscribers.size === 0) {
        registry.delete(surfaceId);
      }
    }
  }

  /** Send data to all subscribers for a surface, removing dead ones. */
  function fanOut(surfaceId: string, data: Uint8Array): void {
    const subscribers = registry.get(surfaceId);
    if (subscribers === undefined) return;
    const dead = [...subscribers].filter((subscriber) => !subscriber(data));
    for (const subscriber of dead) {
      removeSubscriber(surfaceId, subscriber);
    }
  }

  // Keep-alive: send comment to all subscribers periodically
  const keepAliveTimer = setInterval(() => {
    for (const surfaceId of [...registry.keys()]) {
      fanOut(surfaceId, KEEP_ALIVE_BYTES);
    }
  }, config.keepAliveIntervalMs);

  return {
    subscribe(surfaceId: string, subscriber: SseSubscriber): Result<() => void, KoiError> {
      // Check global limit
      if (total >= config.maxTotalSubscribers) {
        return {
          ok: false,
          error: {
            code: "RATE_LIMIT",
            message: `Global SSE subscriber limit reached (${config.maxTotalSubscribers})`,
            retryable: true,
          },
        };
      }

      // let: reassigned on cache miss when creating a new subscriber set
      let subscribers = registry.get(surfaceId);
      if (subscribers === undefined) {
        subscribers = new Set();
        registry.set(surfaceId, subscribers);
      }

      // Check per-surface limit
      if (subscribers.size >= config.maxSubscribersPerSurface) {
        return {
          ok: false,
          error: {
            code: "RATE_LIMIT",
            message: `Per-surface SSE subscriber limit reached (${config.maxSubscribersPerSurface})`,
            retryable: true,
          },
        };
      }

      subscribers.add(subscriber);
      total++;

      const unsubscribe = (): void => {
        removeSubscriber(surfaceId, subscriber);
      };

      return { ok: true, value: unsubscribe };
    },

    publish(surfaceId: string, event: SseEvent): void {
      fanOut(surfaceId, formatSseEvent(event));
    },

    close(surfaceId: string): void {
      const subscribers = registry.get(surfaceId);
      if (subscribers === undefined) return;
      const deletedEvent = formatSseEvent({
        id: nextEventId(surfaceId),
        event: "deleted",
        data: JSON.stringify({ surfaceId }),
      });
      // Send deleted event to all (ignore dead status since we're removing anyway)
      for (const subscriber of subscribers) {
        subscriber(deletedEvent);
      }
      total -= subscribers.size;
      registry.delete(surfaceId);
      eventCounters.delete(surfaceId);
    },

    dispose(): void {
      clearInterval(keepAliveTimer);
      total = 0;
      registry.clear();
      eventCounters.clear();
    },

    nextEventId,

    subscriberCount(surfaceId: string): number {
      return registry.get(surfaceId)?.size ?? 0;
    },

    totalSubscribers(): number {
      return total;
    },
  };
}
