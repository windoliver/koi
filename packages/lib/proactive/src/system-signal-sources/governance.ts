import type {
  GovernanceController,
  GovernanceSnapshot,
  SensorReading,
  SystemSignal,
  SystemSignalSource,
  SystemSignalSourceOptions,
} from "@koi/core";
import {
  createAsyncEmitter,
  createSubscriptionController,
  matchesAnyPathFilter,
  safeCall,
} from "./shared.js";

export interface GovernanceThreshold {
  readonly sensor: string;
  readonly limit: number;
  readonly direction: "above" | "below";
  readonly cooldownMs?: number | undefined;
}

export interface GovernanceSignalSourceConfig {
  readonly pollIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface ThresholdState {
  alerting: boolean;
  lastEmittedAt: number;
}

function coalesceThresholds(thresholds: readonly GovernanceThreshold[]): GovernanceThreshold[] {
  const coalesced = new Map<string, GovernanceThreshold>();

  for (const threshold of thresholds) {
    const key = `${threshold.sensor}:${threshold.direction}:${threshold.limit}`;
    const previous = coalesced.get(key);
    if (previous === undefined) {
      coalesced.set(key, threshold);
      continue;
    }

    coalesced.set(key, {
      ...previous,
      cooldownMs: Math.min(previous.cooldownMs ?? 0, threshold.cooldownMs ?? 0),
    });
  }

  return [...coalesced.values()];
}

function findMatchingReadings(
  readings: GovernanceSnapshot["readings"],
  threshold: GovernanceThreshold,
): SensorReading[] {
  return readings.filter((reading: SensorReading) =>
    matchesAnyPathFilter(reading.name, [threshold.sensor]),
  );
}

function isAlerting(reading: SensorReading | undefined, threshold: GovernanceThreshold): boolean {
  if (reading === undefined) return false;

  return threshold.direction === "above"
    ? reading.current > threshold.limit
    : reading.current < threshold.limit;
}

function selectAlertingReading(
  readings: readonly SensorReading[],
  threshold: GovernanceThreshold,
): SensorReading | undefined {
  const alertingReadings = readings.filter((reading) => isAlerting(reading, threshold));
  if (alertingReadings.length === 0) return undefined;

  return alertingReadings.reduce((selected, reading) => {
    if (threshold.direction === "above") {
      return reading.current > selected.current ? reading : selected;
    }

    return reading.current < selected.current ? reading : selected;
  });
}

function thresholdKey(index: number, threshold: GovernanceThreshold): string {
  return `${index}:${threshold.sensor}:${threshold.direction}:${threshold.limit}:${threshold.cooldownMs ?? 0}`;
}

interface EvaluateContext {
  readonly snapshot: GovernanceSnapshot;
  readonly threshold: GovernanceThreshold;
  readonly key: string;
  readonly state: Map<string, ThresholdState>;
  readonly now: () => number;
  readonly emitter: { emit: (signal: SystemSignal) => void };
  readonly canDeliver: () => boolean;
  readonly markDelivered: (at: number) => void;
}

function evaluateThreshold(ctx: EvaluateContext): void {
  const { snapshot, threshold, key, state, now, emitter, canDeliver, markDelivered } = ctx;
  const reading = selectAlertingReading(
    findMatchingReadings(snapshot.readings, threshold),
    threshold,
  );
  const nextAlerting = isAlerting(reading, threshold);
  const previous = state.get(key) ?? { alerting: false, lastEmittedAt: -Infinity };

  if (
    nextAlerting &&
    previous.alerting === false &&
    now() - previous.lastEmittedAt >= (threshold.cooldownMs ?? 0) &&
    canDeliver() &&
    reading !== undefined
  ) {
    const emittedAt = now();
    markDelivered(emittedAt);
    emitter.emit({
      kind: "governance",
      sensor: threshold.sensor,
      value: reading.current,
      limit: threshold.limit,
      direction: threshold.direction,
      emittedAt,
    } satisfies SystemSignal);
    state.set(key, { alerting: true, lastEmittedAt: emittedAt });
    return;
  }

  if (nextAlerting && previous.alerting === false && reading !== undefined) {
    state.set(key, { alerting: false, lastEmittedAt: previous.lastEmittedAt });
    return;
  }

  state.set(key, { alerting: nextAlerting, lastEmittedAt: previous.lastEmittedAt });
}

interface PollContext {
  readonly controller: GovernanceController;
  readonly thresholds: readonly GovernanceThreshold[];
  readonly state: Map<string, ThresholdState>;
  readonly now: () => number;
  readonly emitter: { emit: (signal: SystemSignal) => void };
  readonly canDeliver: () => boolean;
  readonly markDelivered: (at: number) => void;
  readonly isClosed: () => boolean;
  readonly options: SystemSignalSourceOptions | undefined;
}

function createPoller(ctx: PollContext): { request: () => void } {
  let inFlight = false;
  let pollRequested = false;

  const drain = async (): Promise<void> => {
    if (ctx.isClosed() || inFlight) return;
    inFlight = true;
    try {
      while (!ctx.isClosed() && pollRequested) {
        pollRequested = false;
        const snapshot = await ctx.controller.snapshot();
        if (ctx.isClosed()) return;
        for (const [index, threshold] of ctx.thresholds.entries()) {
          if (ctx.isClosed()) return;
          evaluateThreshold({
            snapshot,
            threshold,
            key: thresholdKey(index, threshold),
            state: ctx.state,
            now: ctx.now,
            emitter: ctx.emitter,
            canDeliver: ctx.canDeliver,
            markDelivered: ctx.markDelivered,
          });
        }
      }
    } catch (error) {
      if (ctx.isClosed()) return;
      safeCall(ctx.options?.onError, error);
    } finally {
      inFlight = false;
      if (!ctx.isClosed() && pollRequested) {
        void drain();
      }
    }
  };

  return {
    request: () => {
      pollRequested = true;
      void drain();
    },
  };
}

export function createGovernanceSignalSource(
  controller: GovernanceController,
  thresholds: readonly GovernanceThreshold[],
  config: GovernanceSignalSourceConfig = {},
): SystemSignalSource {
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const now = config.now ?? Date.now;
  const normalizedThresholds = coalesceThresholds(thresholds);

  return {
    name: "governance",
    watch(handler, options) {
      let closed = false;
      let lastAcceptedDeliveryAt = -Infinity;
      const emitter = createAsyncEmitter(
        (signal) => {
          if (closed) return;
          handler(signal);
        },
        { ...options, sampleRateMs: undefined },
        now,
        () => closed,
      );
      const state = new Map<string, ThresholdState>();
      const canDeliver = (): boolean => {
        const minGap = options?.sampleRateMs;
        return minGap === undefined || now() - lastAcceptedDeliveryAt >= minGap;
      };
      const poller = createPoller({
        controller,
        thresholds: normalizedThresholds,
        state,
        now,
        emitter,
        canDeliver,
        markDelivered: (at) => {
          lastAcceptedDeliveryAt = at;
        },
        isClosed: () => closed,
        options,
      });

      if (options?.replay === true) poller.request();
      const timer = setInterval(() => poller.request(), pollIntervalMs);

      const subscription = createSubscriptionController(() => {
        closed = true;
        clearInterval(timer);
        safeCall(options?.onDisconnect);
      });

      return () => {
        if (subscription.closed) return;
        subscription.unsubscribe();
      };
    },
  };
}
