/**
 * Mock governance factories for tests.
 *
 * Provides minimal GovernanceController and GovernanceBackend implementations
 * that default to healthy/passing state. Override individual methods via
 * the overrides parameter.
 */

import type {
  ComplianceRecord,
  ComplianceRecorder,
  ConstraintChecker,
  GovernanceBackend,
  GovernanceCheck,
  GovernanceController,
  GovernanceEvent,
  GovernanceSnapshot,
  GovernanceVariable,
  GovernanceVerdict,
  PolicyEvaluator,
  PolicyRequest,
  PolicyRequestKind,
  SensorReading,
  ViolationFilter,
  ViolationPage,
  ViolationStore,
} from "@koi/core";
import { GOVERNANCE_ALLOW } from "@koi/core";

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

// ---------------------------------------------------------------------------
// GovernanceBackend mock
// ---------------------------------------------------------------------------

export interface MockGovernanceBackendOverrides {
  readonly evaluator?: {
    readonly evaluate?: PolicyEvaluator["evaluate"];
    readonly scope?: readonly PolicyRequestKind[];
  };
  readonly constraints?: {
    readonly checkConstraint?: ConstraintChecker["checkConstraint"];
  };
  readonly compliance?: {
    readonly recordCompliance?: ComplianceRecorder["recordCompliance"];
  };
  readonly violations?: {
    readonly getViolations?: ViolationStore["getViolations"];
  };
  readonly dispose?: () => void | Promise<void>;
}

const EMPTY_VIOLATION_PAGE: ViolationPage = Object.freeze({
  items: Object.freeze([]),
  total: 0,
});

export function createMockGovernanceBackend(
  overrides?: MockGovernanceBackendOverrides | undefined,
): GovernanceBackend {
  const evaluator: PolicyEvaluator = {
    evaluate:
      overrides?.evaluator?.evaluate ??
      ((_request: PolicyRequest): GovernanceVerdict => GOVERNANCE_ALLOW),
    ...(overrides?.evaluator?.scope !== undefined ? { scope: overrides.evaluator.scope } : {}),
  };

  return {
    evaluator,
    ...(overrides?.constraints !== undefined
      ? {
          constraints: {
            checkConstraint: overrides.constraints.checkConstraint ?? ((): boolean => true),
          } satisfies ConstraintChecker,
        }
      : {}),
    ...(overrides?.compliance !== undefined
      ? {
          compliance: {
            recordCompliance:
              overrides.compliance.recordCompliance ??
              ((record: ComplianceRecord): ComplianceRecord => record),
          } satisfies ComplianceRecorder,
        }
      : {}),
    ...(overrides?.violations !== undefined
      ? {
          violations: {
            getViolations:
              overrides.violations.getViolations ??
              ((_filter: ViolationFilter): ViolationPage => EMPTY_VIOLATION_PAGE),
          } satisfies ViolationStore,
        }
      : {}),
    ...(overrides?.dispose !== undefined ? { dispose: overrides.dispose } : {}),
  };
}
