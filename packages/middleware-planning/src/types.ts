/**
 * Planning middleware types — plan items and configuration.
 */

/** Status of a single plan item. */
export type PlanStatus = "pending" | "in_progress" | "completed";

/** A single item in the structured plan. */
export interface PlanItem {
  readonly content: string;
  readonly status: PlanStatus;
}

/** Factory configuration for createPlanMiddleware. */
export interface PlanConfig {
  /** Optional push notification when plan changes. */
  readonly onPlanUpdate?: ((plan: readonly PlanItem[]) => void) | undefined;
  /** Middleware priority (default: 450). */
  readonly priority?: number | undefined;
}
