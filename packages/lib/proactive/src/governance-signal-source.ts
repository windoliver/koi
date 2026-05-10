/**
 * Governance threshold → SystemSignal adapter.
 *
 * Polls a GovernanceController at a fixed interval, detects threshold
 * crossings (rising/falling edges), and emits SystemSignal{kind:"governance"}
 * on each crossing. Per-sensor cooldown debounces repeated crossings.
 *
 * Single shared polling loop fans out to all subscribers. Loop starts on
 * first watch() and is cleared on last unsubscribe.
 */

import type {
  GovernanceController,
  SensorReading,
  SystemSignal,
  SystemSignalSource,
} from "@koi/core";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_COOLDOWN_MS = 60_000;

/** Opaque interval handle returned by `setIntervalFn`. */
export type IntervalHandle = unknown;

/** Test-friendly setInterval signature — narrower than the host overload set. */
export type IntervalScheduler = (fn: () => void, ms: number) => IntervalHandle;

/** Test-friendly clearInterval signature. */
export type IntervalCanceller = (handle: IntervalHandle) => void;

export interface GovernanceThreshold {
  readonly sensor: string;
  readonly limit: number;
  readonly direction: "above" | "below";
  readonly cooldownMs?: number;
}

export interface GovernanceSignalSourceConfig {
  readonly controller: GovernanceController;
  readonly thresholds: readonly GovernanceThreshold[];
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: IntervalScheduler;
  readonly clearInterval?: IntervalCanceller;
}

interface Subscriber {
  readonly handler: (signal: SystemSignal) => void;
  readonly onError: ((err: unknown) => void) | undefined;
}

interface SensorState {
  /** True when the most recent reading was past the threshold (outside-bound). */
  readonly outside: boolean;
  /** Wall-clock ms of the last emission for this sensor; -Infinity = never. */
  readonly lastEmittedAt: number;
}

function isCrossed(value: number, threshold: GovernanceThreshold): boolean {
  return threshold.direction === "above" ? value > threshold.limit : value < threshold.limit;
}

function readSafely(
  controller: GovernanceController,
  sensor: string,
): { ok: true; value: SensorReading | undefined } | { ok: false; err: unknown } {
  try {
    return { ok: true, value: controller.reading(sensor) };
  } catch (e: unknown) {
    return { ok: false, err: e };
  }
}

export function createGovernanceSignalSource(
  config: GovernanceSignalSourceConfig,
): SystemSignalSource {
  const {
    controller,
    thresholds,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
  } = config;

  const setIntervalFn: IntervalScheduler =
    config.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIntervalFn: IntervalCanceller =
    config.clearInterval ??
    ((handle) =>
      globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]));

  const subscribers = new Set<Subscriber>();
  const sensorState = new Map<string, SensorState>();
  // let: holds the active interval handle (or undefined when no subscribers).
  // Reassigned by start/stop on subscription churn.
  let intervalHandle: IntervalHandle | undefined;

  function getOrInitState(sensor: string): SensorState {
    const existing = sensorState.get(sensor);
    if (existing !== undefined) return existing;
    const fresh: SensorState = { outside: false, lastEmittedAt: Number.NEGATIVE_INFINITY };
    sensorState.set(sensor, fresh);
    return fresh;
  }

  function emit(signal: SystemSignal): void {
    // Snapshot to avoid mutation during iteration; recheck membership in the
    // microtask so handlers unsubscribed between schedule and fire do not run.
    const snapshot = Array.from(subscribers);
    for (const sub of snapshot) {
      queueMicrotask(() => {
        if (!subscribers.has(sub)) return;
        try {
          sub.handler(signal);
        } catch (e: unknown) {
          sub.onError?.(e);
        }
      });
    }
  }

  function notifyError(err: unknown): void {
    for (const sub of subscribers) {
      sub.onError?.(err);
    }
  }

  function poll(): void {
    const t = now();
    for (const threshold of thresholds) {
      const result = readSafely(controller, threshold.sensor);
      if (!result.ok) {
        notifyError(result.err);
        continue;
      }
      const reading = result.value;
      if (reading === undefined) {
        notifyError(new Error(`governance signal source: unknown sensor '${threshold.sensor}'`));
        continue;
      }
      const state = getOrInitState(threshold.sensor);
      const crossed = isCrossed(reading.current, threshold);
      if (!crossed) {
        // Re-entry to inside-bound arms the sensor for the next emission.
        sensorState.set(threshold.sensor, { ...state, outside: false });
        continue;
      }
      // Currently outside-bound. Only emit on the *transition* (rising edge).
      if (state.outside) continue;
      const armed: SensorState = { ...state, outside: true };
      sensorState.set(threshold.sensor, armed);
      const cooldown = threshold.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (t - armed.lastEmittedAt < cooldown) continue;
      sensorState.set(threshold.sensor, { ...armed, lastEmittedAt: t });
      emit({
        kind: "governance",
        sensor: threshold.sensor,
        value: reading.current,
        limit: threshold.limit,
        direction: threshold.direction,
        emittedAt: t,
      });
    }
  }

  function startIntervalIfNeeded(): void {
    if (intervalHandle !== undefined) return;
    intervalHandle = setIntervalFn(poll, pollIntervalMs);
  }

  function stopIntervalIfIdle(): void {
    if (subscribers.size > 0 || intervalHandle === undefined) return;
    clearIntervalFn(intervalHandle);
    intervalHandle = undefined;
    // Reset edge state when the loop stops. A future watcher treats the next
    // reading as the start of a fresh crossing series — intentional, since the
    // new subscriber should see the current condition, not history from before
    // it was watching.
    sensorState.clear();
  }

  return {
    name: "governance",
    watch: (handler, options) => {
      const sub: Subscriber = { handler, onError: options?.onError };
      subscribers.add(sub);
      startIntervalIfNeeded();
      return () => {
        subscribers.delete(sub);
        stopIntervalIfIdle();
      };
    },
  };
}
