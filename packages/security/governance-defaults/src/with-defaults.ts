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
  /**
   * Pricing entry used to seed the controller's per-token fallback when
   * `cost.calculate()` throws (unknown model alias). Defaults to the pricing
   * table's `claude-sonnet-4-6` entry — a conservative mid-range rate that
   * keeps the spend cap advancing rather than fail-open. Set to `null` to
   * disable fallback and let the spend cap stop advancing on pricing failure.
   */
  readonly fallbackPricing?: PricingEntry | null | undefined;
}

/**
 * Default fallback pricing anchor — claude-sonnet-4-6 rates. Picked as a
 * conservative mid-range default so unknown model aliases still advance the
 * spend cap. Over-billing is safer than under-billing for a cap.
 */
const DEFAULT_FALLBACK_MODEL = "claude-sonnet-4-6";

export function withGovernanceDefaults(
  overrides: WithGovernanceDefaultsOverrides = {},
): DefaultGovernanceConfig {
  const pricing = overrides.pricing ?? DEFAULT_PRICING;

  // Resolve the fallback pricing: caller override → caller's pricing table's
  // sonnet entry → shipped DEFAULT_PRICING's sonnet entry → no fallback.
  // The third step matters: a caller-supplied custom pricing map may omit
  // `claude-sonnet-4-6`, and without this floor the helper would silently
  // disable fallback accounting and reopen the spend-cap fail-open path.
  // If the helper built the controller AND no explicit fallback config is
  // set in `controllerConfig`, seed the fallback into the controller so the
  // spend cap still advances when the cost calculator throws for an unknown
  // model. A caller-supplied controller is not touched.
  let fallbackEntry: PricingEntry | null;
  if (overrides.fallbackPricing === null) {
    fallbackEntry = null;
  } else if (overrides.fallbackPricing !== undefined) {
    fallbackEntry = overrides.fallbackPricing;
  } else {
    fallbackEntry =
      pricing[DEFAULT_FALLBACK_MODEL] ?? DEFAULT_PRICING[DEFAULT_FALLBACK_MODEL] ?? null;
  }

  const baseControllerConfig = overrides.controllerConfig ?? {};
  const controllerConfig: InMemoryControllerConfig =
    fallbackEntry !== null &&
    baseControllerConfig.fallbackInputUsdPer1M === undefined &&
    baseControllerConfig.fallbackOutputUsdPer1M === undefined
      ? {
          ...baseControllerConfig,
          fallbackInputUsdPer1M: fallbackEntry.inputUsdPer1M,
          fallbackOutputUsdPer1M: fallbackEntry.outputUsdPer1M,
        }
      : baseControllerConfig;

  const controller = overrides.controller ?? createInMemoryController(controllerConfig);

  const backend =
    overrides.backend ??
    createPatternBackend({
      rules: overrides.rules ?? [],
      defaultDeny: overrides.defaultDeny ?? false,
    });

  const cost = overrides.cost ?? createFlatRateCostCalculator(pricing);

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
