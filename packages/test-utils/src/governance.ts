/**
 * Mock governance controller for tests.
 *
 * Provides a minimal GovernanceController that defaults to healthy/passing
 * state. Override individual methods via the overrides parameter.
 */

import type {
  GovernanceCheck,
  GovernanceController,
  GovernanceEvent,
  GovernanceSnapshot,
  GovernanceVariable,
  SensorReading,
} from "@koi/core";

export interface MockGovernanceControllerOverrides {
  readonly check?: (variable: string) => GovernanceCheck | Promise<GovernanceCheck>;
  readonly checkAll?: () => GovernanceCheck | Promise<GovernanceCheck>;
  readonly record?: (event: GovernanceEvent) => void | Promise<void>;
  readonly snapshot?: () => GovernanceSnapshot | Promise<GovernanceSnapshot>;
  readonly variables?: () => ReadonlyMap<string, GovernanceVariable>;
  readonly reading?: (variable: string) => SensorReading | undefined;
}

const OK_CHECK: GovernanceCheck = { ok: true } as const;

const EMPTY_SNAPSHOT: GovernanceSnapshot = Object.freeze({
  timestamp: 0,
  readings: Object.freeze([]),
  healthy: true,
  violations: Object.freeze([]),
});

export function createMockGovernanceController(
  overrides?: MockGovernanceControllerOverrides | undefined,
): GovernanceController {
  return {
    check: overrides?.check ?? ((): GovernanceCheck => OK_CHECK),
    checkAll: overrides?.checkAll ?? ((): GovernanceCheck => OK_CHECK),
    record: overrides?.record ?? ((): void => {}),
    snapshot: overrides?.snapshot ?? ((): GovernanceSnapshot => EMPTY_SNAPSHOT),
    variables: overrides?.variables ?? ((): ReadonlyMap<string, GovernanceVariable> => new Map()),
    reading: overrides?.reading ?? ((): SensorReading | undefined => undefined),
  };
}
