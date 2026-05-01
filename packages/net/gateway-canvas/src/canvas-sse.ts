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
  const eventCounters = new Map<string, number>();
  // let: total subscriber count across all surfaces (mutated on subscribe/unsubscribe)
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
      total -= 1;
      if (subscribers.size === 0) {
        registry.delete(surfaceId);
      }
    }
  }

  function fanOut(surfaceId: string, data: Uint8Array): void {
    const subscribers = registry.get(surfaceId);
    if (subscribers === undefined) return;
    const dead = [...subscribers].filter((subscriber) => !subscriber(data));
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
    subscribe(surfaceId, subscriber) {
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

      subscribers.add(subscriber);
      total += 1;

      const unsubscribe = (): void => {
        removeSubscriber(surfaceId, subscriber);
      };

      return { ok: true, value: unsubscribe };
    },

    publish(surfaceId, event) {
      fanOut(surfaceId, formatSseEvent(event));
    },

    close(surfaceId) {
      const subscribers = registry.get(surfaceId);
      if (subscribers === undefined) return;
      const deletedEvent = formatSseEvent({
        id: nextEventId(surfaceId),
        event: "deleted",
        data: JSON.stringify({ surfaceId }),
      });
      for (const subscriber of subscribers) {
        subscriber(deletedEvent);
      }
      total -= subscribers.size;
      registry.delete(surfaceId);
      eventCounters.delete(surfaceId);
    },

    dispose() {
      clearInterval(keepAliveTimer);
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
