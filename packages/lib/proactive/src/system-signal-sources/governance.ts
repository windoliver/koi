import type {
  GovernanceController,
  GovernanceSnapshot,
  SensorReading,
  SystemSignal,
  SystemSignalSource,
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

function findMatchingReadings(
  readings: GovernanceSnapshot["readings"],
  threshold: GovernanceThreshold,
): SensorReading[] {
  return readings.filter((reading) => matchesAnyPathFilter(reading.name, [threshold.sensor]));
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

export function createGovernanceSignalSource(
  controller: GovernanceController,
  thresholds: readonly GovernanceThreshold[],
  config: GovernanceSignalSourceConfig = {},
): SystemSignalSource {
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const now = config.now ?? Date.now;

  return {
    name: "governance",
    watch(handler, options) {
      let closed = false;
      const emitter = createAsyncEmitter((signal) => {
        if (closed) return;
        handler(signal);
      }, options, now);
      const state = new Map<string, { alerting: boolean; lastEmittedAt: number }>();
      let inFlight = false;
      let nextPollRequestId = 0;
      let lastStartedPollRequestId = 0;

      const drainPolls = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          while (!closed && lastStartedPollRequestId < nextPollRequestId) {
            const pollRequestId = nextPollRequestId;
            lastStartedPollRequestId = pollRequestId;
            const snapshot: GovernanceSnapshot = await controller.snapshot();
            if (closed) return;
            if (pollRequestId !== nextPollRequestId) continue;

            for (const threshold of thresholds) {
              if (closed || pollRequestId !== nextPollRequestId) return;

              const reading = selectAlertingReading(
                findMatchingReadings(snapshot.readings, threshold),
                threshold,
              );
              const nextAlerting = isAlerting(reading, threshold);
              const key = `${threshold.sensor}:${threshold.direction}:${threshold.limit}`;
              const previous = state.get(key) ?? { alerting: false, lastEmittedAt: -Infinity };

              if (
                nextAlerting &&
                previous.alerting === false &&
                now() - previous.lastEmittedAt >= (threshold.cooldownMs ?? 0) &&
                reading !== undefined
              ) {
                const emittedAt = now();
                if (closed || pollRequestId !== nextPollRequestId) return;
                emitter.emit({
                  kind: "governance",
                  sensor: threshold.sensor,
                  value: reading.current,
                  limit: threshold.limit,
                  direction: threshold.direction,
                  emittedAt,
                } satisfies SystemSignal);
                state.set(key, { alerting: true, lastEmittedAt: emittedAt });
                continue;
              }

              state.set(key, { alerting: nextAlerting, lastEmittedAt: previous.lastEmittedAt });
            }
          }
        } catch (error) {
          if (closed || lastStartedPollRequestId !== nextPollRequestId) return;
          safeCall(options?.onError, error);
        } finally {
          inFlight = false;
          if (!closed && lastStartedPollRequestId < nextPollRequestId) {
            void drainPolls();
          }
        }
      };

      const requestPoll = () => {
        nextPollRequestId += 1;
        void drainPolls();
      };

      if (options?.replay === true) requestPoll();

      const timer = setInterval(() => {
        requestPoll();
      }, pollIntervalMs);

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
