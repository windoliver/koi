import type { GovernanceSnapshot, SensorReading } from "@koi/core/governance";

export type AlertCallback = (pctUsed: number, variable: string, reading: SensorReading) => void;

export interface AlertTrackerConfig {
  readonly thresholds: readonly number[];
  readonly perVariableThresholds?: Record<string, readonly number[]> | undefined;
}

export interface AlertTracker {
  readonly checkAndFire: (
    sessionId: string,
    snapshot: GovernanceSnapshot,
    onAlert: AlertCallback | undefined,
  ) => void;
  readonly cleanup: (sessionId: string) => void;
}

export function createAlertTracker(config: AlertTrackerConfig): AlertTracker {
  const sortedGlobal = [...config.thresholds].sort((a, b) => a - b);
  const sortedPerVar = new Map<string, readonly number[]>();
  if (config.perVariableThresholds !== undefined) {
    for (const [v, ts] of Object.entries(config.perVariableThresholds)) {
      sortedPerVar.set(
        v,
        [...ts].sort((a, b) => a - b),
      );
    }
  }
  const fired = new Map<string, Set<string>>();

  function thresholdsFor(variable: string): readonly number[] {
    return sortedPerVar.get(variable) ?? sortedGlobal;
  }

  function firedKey(variable: string, threshold: number): string {
    return `${variable}@${threshold}`;
  }

  function getFiredSet(sessionId: string): Set<string> {
    const existing = fired.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = new Set<string>();
    fired.set(sessionId, fresh);
    return fresh;
  }

  return {
    checkAndFire(sessionId, snapshot, onAlert) {
      if (onAlert === undefined) return;
      const firedSet = getFiredSet(sessionId);
      for (const reading of snapshot.readings) {
        for (const threshold of thresholdsFor(reading.name)) {
          const key = firedKey(reading.name, threshold);
          if (reading.utilization >= threshold && !firedSet.has(key)) {
            firedSet.add(key);
            onAlert(reading.utilization, reading.name, reading);
          }
        }
      }
    },
    cleanup(sessionId) {
      fired.delete(sessionId);
    },
  };
}
