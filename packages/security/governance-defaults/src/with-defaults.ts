import type { GovernanceController, GovernanceSnapshot, SensorReading } from "@koi/core/governance";
import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core/governance-backend";
import type { CostCalculator, PricingEntry } from "./cost-calculator.js";
import { createFlatRateCostCalculator } from "./cost-calculator.js";
import { DEFAULT_PRICING } from "./default-pricing.js";
import type { InMemoryControllerConfig } from "./in-memory-controller.js";
import { createInMemoryController } from "./in-memory-controller.js";
import type { PatternRule } from "./pattern-backend.js";
import { createPatternBackend } from "./pattern-backend.js";

/**
 * Structural mirror of the `GovernanceMiddlewareConfig` shape from
 * `@koi/governance-core` so this L2 package produces a drop-in value for
 * `createGovernanceMiddleware` without adding an L2-to-L2 runtime dep.
 * TypeScript's structural typing makes the two interchangeable at the
 * call site.
 */
export type AlertCallback = (pctUsed: number, variable: string, reading: SensorReading) => void;
export type ViolationCallback = (verdict: GovernanceVerdict, request: PolicyRequest) => void;
export type UsageCallback = (event: {
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number | undefined;
  };
  readonly costUsd: number;
}) => void;

export interface DefaultGovernanceConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}

// Surface the underlying snapshot/controller types without requiring callers
// to import `@koi/core/governance` themselves.
export type { GovernanceSnapshot };

export interface WithGovernanceDefaultsOverrides {
  readonly controller?: GovernanceController | undefined;
  readonly backend?: GovernanceBackend | undefined;
  readonly cost?: CostCalculator | undefined;
  readonly pricing?: Readonly<Record<string, PricingEntry>> | undefined;
  readonly controllerConfig?: InMemoryControllerConfig | undefined;
  readonly rules?: readonly PatternRule[] | undefined;
  readonly defaultDeny?: boolean | undefined;
  readonly alertThresholds?: readonly number[] | undefined;
  readonly onAlert?: AlertCallback | undefined;
  readonly onViolation?: ViolationCallback | undefined;
  readonly onUsage?: UsageCallback | undefined;
}

export function withGovernanceDefaults(
  overrides: WithGovernanceDefaultsOverrides = {},
): DefaultGovernanceConfig {
  const controller =
    overrides.controller ?? createInMemoryController(overrides.controllerConfig ?? {});

  const backend =
    overrides.backend ??
    createPatternBackend({
      rules: overrides.rules ?? [],
      defaultDeny: overrides.defaultDeny ?? false,
    });

  const cost = overrides.cost ?? createFlatRateCostCalculator(overrides.pricing ?? DEFAULT_PRICING);

  const config: DefaultGovernanceConfig = {
    backend,
    controller,
    cost,
    ...(overrides.alertThresholds !== undefined
      ? { alertThresholds: overrides.alertThresholds }
      : {}),
    ...(overrides.onAlert !== undefined ? { onAlert: overrides.onAlert } : {}),
    ...(overrides.onViolation !== undefined ? { onViolation: overrides.onViolation } : {}),
    ...(overrides.onUsage !== undefined ? { onUsage: overrides.onUsage } : {}),
  };

  return config;
}
