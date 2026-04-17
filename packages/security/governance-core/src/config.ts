import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { GovernanceController } from "@koi/core/governance";
import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core/governance-backend";
import type { AlertCallback } from "./alert-tracker.js";
import type { CostCalculator } from "./cost-calculator.js";
import type { NormalizedUsage } from "./normalize-usage.js";

export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = Object.freeze([0.8, 0.95]);

export type ViolationCallback = (verdict: GovernanceVerdict, request: PolicyRequest) => void;
export type UsageCallback = (event: {
  readonly model: string;
  readonly usage: NormalizedUsage;
  readonly costUsd: number;
}) => void;

export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}

function err(message: string, context?: Record<string, unknown>): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    ...(context !== undefined ? { context: context as never } : {}),
  };
}

export function validateGovernanceConfig(
  input: unknown,
): Result<GovernanceMiddlewareConfig, KoiError> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: err("config must be an object") };
  }
  const c = input as Partial<GovernanceMiddlewareConfig>;
  if (c.backend === undefined || typeof c.backend.evaluator?.evaluate !== "function") {
    return { ok: false, error: err("config.backend.evaluator.evaluate is required") };
  }
  if (
    c.controller === undefined ||
    typeof c.controller.checkAll !== "function" ||
    typeof c.controller.record !== "function" ||
    typeof c.controller.snapshot !== "function"
  ) {
    return { ok: false, error: err("config.controller is required with checkAll/record/snapshot") };
  }
  if (c.cost === undefined || typeof c.cost.calculate !== "function") {
    return { ok: false, error: err("config.cost.calculate is required") };
  }
  if (c.alertThresholds !== undefined) {
    for (const t of c.alertThresholds) {
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
        return {
          ok: false,
          error: err("alertThresholds must be numbers in [0, 1]", { threshold: t }),
        };
      }
    }
  }
  return { ok: true, value: c as GovernanceMiddlewareConfig };
}
