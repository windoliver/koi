/**
 * SSE (Server-Sent Events) subscriber registry for canvas surfaces.
 *
 * Manages per-surface fan-out, keep-alive pings, connection limits, and
 * automatic dead-subscriber cleanup.
 */

import type { CanvasSseConfig, CanvasSseManager, SseEvent, SseSubscriber } from "./types.js";

const DEFAULT_CANVAS_SSE_CONFIG: CanvasSseConfig = {
  maxSubscribersPerSurface: 100,
  maxTotalSubscribers: 10_000,
  keepAliveIntervalMs: 15_000,
} as const;

const encoder = new TextEncoder();

/** Strip CR/LF from SSE field values to prevent injection. */
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

export function createCanvasSseManager(
  configOverrides?: Partial<CanvasSseConfig>,
): CanvasSseManager {
  const config: CanvasSseConfig = { ...DEFAULT_CANVAS_SSE_CONFIG, ...configOverrides };
  const registry = new Map<string, Set<SseSubscriber>>();
  // Per-subscriber onClose hooks. Stored separately so the public
  // SseSubscriber type stays a plain function and existing consumers do
  // not need to change. Hook fires after removal from the registry —
  // including via `close(surfaceId)` teardown — so the route layer can
  // terminate the underlying ReadableStream.
  const closeHooks = new WeakMap<SseSubscriber, () => void>();
  const eventCounters = new Map<string, number>();
  // let: total subscriber count across all surfaces (mutated on subscribe/unsubscribe)
  let total = 0;

  function nextEventId(surfaceId: string): string {
    const counter = (eventCounters.get(surfaceId) ?? 0) + 1;
    eventCounters.set(surfaceId, counter);
    return String(counter);
  }

  function fireCloseHook(subscriber: SseSubscriber): void {
    const hook = closeHooks.get(subscriber);
    if (hook === undefined) return;
    closeHooks.delete(subscriber);
    try {
      hook();
    } catch {
      // Hooks must never escape; a throwing route-side hook would take
      // down `close()` mid-fanout and leave other subscribers stranded.
    }
  }

  function removeSubscriber(surfaceId: string, subscriber: SseSubscriber): void {
    const subscribers = registry.get(surfaceId);
    if (subscribers === undefined) return;
    if (subscribers.delete(subscriber)) {
      total -= 1;
      if (subscribers.size === 0) {
        registry.delete(surfaceId);
      }
      fireCloseHook(subscriber);
    }
  }

  // Subscriber callbacks must never escape: a throwing or returning-false
  // subscriber is a dead connection. Letting an exception bubble would turn a
  // committed write (PATCH/DELETE) into a 500, or take down the keep-alive
  // timer.
  function safeDeliver(subscriber: SseSubscriber, data: Uint8Array): boolean {
    try {
      return subscriber(data);
    } catch {
      return false;
    }
  }

  function fanOut(surfaceId: string, data: Uint8Array): void {
    const subscribers = registry.get(surfaceId);
    if (subscribers === undefined) return;
    const dead = [...subscribers].filter((subscriber) => !safeDeliver(subscriber, data));
    for (const subscriber of dead) {
      removeSubscriber(surfaceId, subscriber);
    }
  }

  const keepAliveTimer = setInterval(() => {
    for (const surfaceId of [...registry.keys()]) {
      fanOut(surfaceId, KEEP_ALIVE_BYTES);
    }
  }, config.keepAliveIntervalMs);

  return {
    subscribe(surfaceId, subscriber, onClose) {
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

      // let: looked up below, may need to create new Set on miss
      let subscribers = registry.get(surfaceId);
      if (subscribers === undefined) {
        subscribers = new Set();
        registry.set(surfaceId, subscribers);
      }

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

      // Only increment `total` when the set actually grew. Duplicate
      // registrations of the same callback otherwise inflate `total`
      // permanently — a single `unsubscribe()` would then leave `total > 0`
      // with zero real subscribers, eventually returning false 503
      // saturation errors to real clients.
      const sizeBefore = subscribers.size;
      subscribers.add(subscriber);
      if (subscribers.size === sizeBefore) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "Subscriber already registered for this surface",
            retryable: false,
          },
        };
      }
      total += 1;
      if (onClose !== undefined) closeHooks.set(subscriber, onClose);

      const unsubscribe = (): void => {
        removeSubscriber(surfaceId, subscriber);
      };

      return { ok: true, value: unsubscribe };
    },

    publish(surfaceId, event) {
      fanOut(surfaceId, formatSseEvent(event));
    },

    close(surfaceId) {
      // Pure teardown: callers MUST publish a `deleted` event with the
      // public surfaceId BEFORE calling close(). Embedding `surfaceId`
      // here would leak the registry key (which is tenant-qualified in
      // the route layer) to clients on every delete.
      //
      // Fires each subscriber's `onClose` hook AFTER removal so the route
      // layer can terminate the underlying ReadableStream — without this,
      // a deleted surface leaves clients on a zombie HTTP connection that
      // will never receive another event and never frees its socket.
      const subscribers = registry.get(surfaceId);
      if (subscribers === undefined) return;
      total -= subscribers.size;
      registry.delete(surfaceId);
      eventCounters.delete(surfaceId);
      for (const subscriber of subscribers) fireCloseHook(subscriber);
    },

    dispose() {
      clearInterval(keepAliveTimer);
      // Fire close hooks for every live subscriber so consumers (route
      // ReadableStreams, etc.) terminate cleanly on manager shutdown.
      for (const subscribers of registry.values()) {
        for (const subscriber of subscribers) fireCloseHook(subscriber);
      }
      total = 0;
      registry.clear();
      eventCounters.clear();
    },

    nextEventId,

    subscriberCount(surfaceId): number {
      return registry.get(surfaceId)?.size ?? 0;
    },

    totalSubscribers(): number {
      return total;
    },
  };
}
