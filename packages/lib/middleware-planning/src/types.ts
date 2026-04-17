/**
 * Planning middleware types — plan items and configuration.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  readonly content: string;
  readonly status: PlanStatus;
}

export interface PlanConfig {
  readonly onPlanUpdate?: ((plan: readonly PlanItem[]) => void) | undefined;
  /** Middleware priority (default: 450). */
  readonly priority?: number | undefined;
}
