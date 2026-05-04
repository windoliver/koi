import type { ForgePolicy } from "@koi/forge-types";

/**
 * Operator-tunable rules for `evaluatePolicy`. Extends the L0 `ForgePolicy`
 * with two L2-only fields: `maxComplexity` and `forbiddenNamespaces`. Both
 * are optional — omit either to skip that gate.
 */
export interface ForgePolicyConfig extends ForgePolicy {
  /**
   * Reject candidates whose `spec`-derived complexity score (from
   * `EvaluatePolicyOptions.spec` + `complexityOf`, defaulting to JSON byte
   * length) exceeds this ceiling. Omit to skip the check.
   */
  readonly maxComplexity?: number;

  /**
   * Reject candidates whose `name` starts with any listed prefix. Used to
   * wall off reserved names (e.g. `system.`, `koi.`, `internal.`).
   * Case-sensitive prefix match.
   */
  readonly forbiddenNamespaces?: readonly string[];
}

/**
 * Explicit operator override. When `granted === true` AND attached to an
 * `evaluatePolicy` call, a verdict that would have been `deny` or
 * `require-approval` is rewritten to `allow`. Override never tightens an
 * already-`allow` verdict.
 *
 * `reason` and `grantedBy` are required at audit-record time (the override
 * can be constructed loosely but the audit log refuses to persist a missing
 * reason or actor).
 */
export interface PolicyOverride {
  readonly granted: boolean;
  readonly reason: string;
  readonly grantedBy: string;
}
