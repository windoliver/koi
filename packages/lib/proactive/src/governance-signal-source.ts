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

import type { GovernanceController, SystemSignal, SystemSignalSource } from "@koi/core";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_COOLDOWN_MS = 60_000;

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
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

interface Subscriber {
  readonly handler: (signal: SystemSignal) => void;
  readonly onError: ((err: unknown) => void) | undefined;
}

interface SensorState {
  /** True when the most recent reading was past the threshold (outside-bound). */
  outside: boolean;
  /** Wall-clock ms of the last emission for this sensor; -Infinity = never. */
  lastEmittedAt: number;
}

function isCrossed(value: number, threshold: GovernanceThreshold): boolean {
  return threshold.direction === "above" ? value > threshold.limit : value < threshold.limit;
}

export function createGovernanceSignalSource(
  config: GovernanceSignalSourceConfig,
): SystemSignalSource {
  const {
    controller,
    thresholds,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
  } = config;

  const subscribers = new Set<Subscriber>();
  const sensorState = new Map<string, SensorState>();
  let intervalHandle: ReturnType<typeof globalThis.setInterval> | undefined;

  function getOrInitState(sensor: string): SensorState {
    let s = sensorState.get(sensor);
    if (s === undefined) {
      s = { outside: false, lastEmittedAt: Number.NEGATIVE_INFINITY };
      sensorState.set(sensor, s);
    }
    return s;
  }

  function emit(signal: SystemSignal): void {
    for (const sub of subscribers) {
      queueMicrotask(() => {
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
      let reading: ReturnType<GovernanceController["reading"]>;
      try {
        reading = controller.reading(threshold.sensor);
      } catch (e: unknown) {
        notifyError(e);
        continue;
      }
      if (reading === undefined) {
        notifyError(new Error(`governance signal source: unknown sensor '${threshold.sensor}'`));
        continue;
      }
      const state = getOrInitState(threshold.sensor);
      const crossed = isCrossed(reading.current, threshold);
      if (!crossed) {
        // Re-entry to inside-bound arms the sensor for the next emission.
        state.outside = false;
        continue;
      }
      // Currently outside-bound. Only emit on the *transition* (rising edge).
      if (state.outside) continue;
      state.outside = true;
      const cooldown = threshold.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (t - state.lastEmittedAt < cooldown) continue;
      state.lastEmittedAt = t;
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
