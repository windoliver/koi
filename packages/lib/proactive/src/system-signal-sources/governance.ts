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

function isAlerting(reading: SensorReading | undefined, threshold: GovernanceThreshold): boolean {
  if (reading === undefined) return false;

  return threshold.direction === "above"
    ? reading.current > threshold.limit
    : reading.current < threshold.limit;
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
      const emitter = createAsyncEmitter(handler, options, now);
      const state = new Map<string, { alerting: boolean; lastEmittedAt: number }>();

      const poll = async () => {
        try {
          const snapshot: GovernanceSnapshot = await controller.snapshot();

          for (const threshold of thresholds) {
            const reading = snapshot.readings.find((entry) =>
              matchesAnyPathFilter(entry.name, [threshold.sensor]),
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
        } catch (error) {
          safeCall(options?.onError, error);
        }
      };

      if (options?.replay === true) void poll();

      const timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);

      const subscription = createSubscriptionController(() => {
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
