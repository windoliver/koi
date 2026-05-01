/**
 * SSE (Server-Sent Events) subscriber registry for canvas surfaces.
 *
 * Manages per-surface fan-out, keep-alive pings, connection limits, and
 * automatic dead-subscriber cleanup.
 */

import type { Result } from "@koi/core";
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
  const dataLines = event.data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return encoder.encode(`id: ${id}\nevent: ${eventType}\n${dataLines}\n\n`);
}

const KEEP_ALIVE_BYTES = encoder.encode(": keep-alive\n\n");

interface SseState {
  readonly config: CanvasSseConfig;
  readonly registry: Map<string, Set<SseSubscriber>>;
  // Per-subscriber onClose hooks (off the public type so callers don't change).
  // Hook fires AFTER removal so route layer can terminate the ReadableStream.
  readonly closeHooks: WeakMap<SseSubscriber, () => void>;
  readonly eventCounters: Map<string, number>;
  total: number;
}

function fireCloseHook(state: SseState, subscriber: SseSubscriber): void {
  const hook = state.closeHooks.get(subscriber);
  if (hook === undefined) return;
  state.closeHooks.delete(subscriber);
  try {
    hook();
  } catch {
    // Hooks must never escape — a throwing route-side hook would take down
    // close() mid-fanout and strand other subscribers.
  }
}

function removeSubscriber(state: SseState, surfaceId: string, subscriber: SseSubscriber): void {
  const subscribers = state.registry.get(surfaceId);
  if (subscribers === undefined) return;
  if (subscribers.delete(subscriber)) {
    state.total -= 1;
    if (subscribers.size === 0) state.registry.delete(surfaceId);
    fireCloseHook(state, subscriber);
  }
}

function safeDeliver(subscriber: SseSubscriber, data: Uint8Array): boolean {
  // Subscriber callbacks must never escape: a throwing or returning-false
  // subscriber is a dead connection. Letting an exception bubble would turn
  // a committed write (PATCH/DELETE) into a 500, or take down the keep-alive
  // timer.
  try {
    return subscriber(data);
  } catch {
    return false;
  }
}

function fanOut(state: SseState, surfaceId: string, data: Uint8Array): void {
  const subscribers = state.registry.get(surfaceId);
  if (subscribers === undefined) return;
  const dead = [...subscribers].filter((subscriber) => !safeDeliver(subscriber, data));
  for (const subscriber of dead) removeSubscriber(state, surfaceId, subscriber);
}

function sseSubscribe(
  state: SseState,
  surfaceId: string,
  subscriber: SseSubscriber,
  onClose: (() => void) | undefined,
): Result<() => void> {
  if (state.total >= state.config.maxTotalSubscribers) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMIT",
        message: `Global SSE subscriber limit reached (${state.config.maxTotalSubscribers})`,
        retryable: true,
      },
    };
  }
  // let: created on first subscriber for this surface
  let subscribers = state.registry.get(surfaceId);
  if (subscribers === undefined) {
    subscribers = new Set();
    state.registry.set(surfaceId, subscribers);
  }
  if (subscribers.size >= state.config.maxSubscribersPerSurface) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMIT",
        message: `Per-surface SSE subscriber limit reached (${state.config.maxSubscribersPerSurface})`,
        retryable: true,
      },
    };
  }
  // Duplicate-registration check: only increment `total` when the set grew.
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
  state.total += 1;
  if (onClose !== undefined) state.closeHooks.set(subscriber, onClose);
  return { ok: true, value: () => removeSubscriber(state, surfaceId, subscriber) };
}

function sseClose(state: SseState, surfaceId: string): void {
  // Pure teardown: callers MUST publish a `deleted` event BEFORE close().
  // Embedding the registry key here would leak tenant-qualified keys.
  // Fires each subscriber's onClose hook AFTER removal so the route layer
  // can terminate the underlying ReadableStream.
  const subscribers = state.registry.get(surfaceId);
  if (subscribers === undefined) return;
  state.total -= subscribers.size;
  state.registry.delete(surfaceId);
  state.eventCounters.delete(surfaceId);
  for (const subscriber of subscribers) fireCloseHook(state, subscriber);
}

function sseDispose(state: SseState): void {
  for (const subscribers of state.registry.values()) {
    for (const subscriber of subscribers) fireCloseHook(state, subscriber);
  }
  state.total = 0;
  state.registry.clear();
  state.eventCounters.clear();
}

function nextEventId(state: SseState, surfaceId: string): string {
  const counter = (state.eventCounters.get(surfaceId) ?? 0) + 1;
  state.eventCounters.set(surfaceId, counter);
  return String(counter);
}

export function createCanvasSseManager(
  configOverrides?: Partial<CanvasSseConfig>,
): CanvasSseManager {
  const state: SseState = {
    config: { ...DEFAULT_CANVAS_SSE_CONFIG, ...configOverrides },
    registry: new Map(),
    closeHooks: new WeakMap(),
    eventCounters: new Map(),
    total: 0,
  };
  const keepAliveTimer = setInterval(() => {
    for (const surfaceId of [...state.registry.keys()]) {
      fanOut(state, surfaceId, KEEP_ALIVE_BYTES);
    }
  }, state.config.keepAliveIntervalMs);
  return {
    subscribe: (surfaceId, subscriber, onClose) =>
      sseSubscribe(state, surfaceId, subscriber, onClose),
    publish: (surfaceId, event) => fanOut(state, surfaceId, formatSseEvent(event)),
    close: (surfaceId) => sseClose(state, surfaceId),
    dispose: () => {
      clearInterval(keepAliveTimer);
      sseDispose(state);
    },
    nextEventId: (surfaceId) => nextEventId(state, surfaceId),
    subscriberCount: (surfaceId) => state.registry.get(surfaceId)?.size ?? 0,
    totalSubscribers: () => state.total,
  };
}
