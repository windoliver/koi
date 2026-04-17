/**
 * Planning middleware types — plan items and configuration.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  readonly content: string;
  readonly status: PlanStatus;
}

/**
 * Commit hook for a successful `write_plan` call. Fires after the new plan
 * has been staged in memory but BEFORE the tool returns success.
 *
 * Supports sync or async durable persistence. If the hook throws (sync) or
 * rejects (async), the middleware rolls back the in-memory plan to the
 * prior state and returns a tool error so the caller can retry.
 */
export type OnPlanUpdate = (plan: readonly PlanItem[]) => void | Promise<void>;

export interface PlanConfig {
  readonly onPlanUpdate?: OnPlanUpdate | undefined;
  /** Middleware priority (default: 450). */
  readonly priority?: number | undefined;
}
