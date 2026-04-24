import type { AgentId, JsonObject, KoiError, Result, SessionId } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { GovernanceController } from "@koi/core/governance";
import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
  PolicyRequestKind,
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

export interface PersistentGrant {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly payload: JsonObject;
  readonly grantKey: string;
  readonly grantedAt: number;
}

export type PersistentGrantCallback = (grant: PersistentGrant) => void;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000 as const;

export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  /**
   * Per-variable threshold overrides. When set for a variable, REPLACES
   * `alertThresholds` for that variable — does not merge or extend.
   * Validated by `validateGovernanceConfig`: each entry must be a non-empty
   * array of numbers in the range (0, 1].
   */
  readonly perVariableThresholds?: Record<string, readonly number[]>;
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
  /**
   * Observer-only mode — when true, the middleware SKIPS every
   * `controller.record(...)` call (turn / token_usage / tool_success /
   * tool_error). Use this when another component (typically the engine
   * extension `createGovernanceExtension()` from `@koi/engine-reconcile`)
   * is already recording the same events against the same controller —
   * recording from both sources double-counts every variable and trips
   * limits at half the configured cap.
   *
   * Even in observer mode the middleware still:
   *   - calls `evaluator.evaluate()` to gate by policy rules,
   *   - reads `controller.snapshot()` to fire `onAlert`,
   *   - records compliance audit envelopes via `backend.compliance`,
   *   - reports `describeCapabilities()` for trajectory.
   *
   * Default: false (recorder mode). Hosts that compose with the default
   * `createKoi` engine adapter should set this to true.
   */
  readonly observerOnly?: boolean;
  /**
   * Timeout for async approvals triggered by ok:"ask" verdicts.
   * Defaults to DEFAULT_APPROVAL_TIMEOUT_MS (60_000ms) when omitted.
   * When the timer fires before the user responds, the middleware throws
   * KoiRuntimeError({ code: "TIMEOUT" }).
   */
  readonly approvalTimeoutMs?: number;
  /**
   * Observation callback fired when the user grants `always-allow` with
   * scope:"always" on a governance ask. Hosts plug gov-12 persistence here.
   * If omitted, `always` behaves identically to session-only (grant is
   * kept in-memory for the session and dropped on onSessionEnd).
   */
  readonly onApprovalPersist?: PersistentGrantCallback;
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
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
        return {
          ok: false,
          error: err("alertThresholds must be numbers in (0, 1]", { threshold: t }),
        };
      }
    }
  }
  if (c.perVariableThresholds !== undefined) {
    if (typeof c.perVariableThresholds !== "object" || c.perVariableThresholds === null) {
      return { ok: false, error: err("perVariableThresholds must be an object") };
    }
    for (const [variable, thresholds] of Object.entries(c.perVariableThresholds)) {
      if (!Array.isArray(thresholds)) {
        return {
          ok: false,
          error: err(`perVariableThresholds[${variable}] must be an array`, { variable }),
        };
      }
      for (const t of thresholds) {
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
          return {
            ok: false,
            error: err("perVariableThresholds value must be in (0, 1]", {
              variable,
              threshold: t,
            }),
          };
        }
      }
    }
  }
  if (c.approvalTimeoutMs !== undefined) {
    if (
      typeof c.approvalTimeoutMs !== "number" ||
      !Number.isFinite(c.approvalTimeoutMs) ||
      !Number.isInteger(c.approvalTimeoutMs) ||
      c.approvalTimeoutMs <= 0
    ) {
      return {
        ok: false,
        error: err("approvalTimeoutMs must be a positive integer", {
          approvalTimeoutMs: c.approvalTimeoutMs as never,
        }),
      };
    }
  }
  if (c.onApprovalPersist !== undefined && typeof c.onApprovalPersist !== "function") {
    return { ok: false, error: err("onApprovalPersist must be a function") };
  }
  return { ok: true, value: c as GovernanceMiddlewareConfig };
}
