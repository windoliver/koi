/**
 * Local structural mirror of `@koi/middleware-planning`'s plan types.
 *
 * Duplicated rather than imported because L2 packages must not depend on
 * other L2 packages (CLAUDE.md). The shapes are stable and tiny — five
 * lines combined — and a CI golden replay covers end-to-end compatibility
 * with the planning middleware that produces the inputs we consume.
 *
 * If a third consumer of these types appears, hoist them to `@koi/core`
 * (Rule of Three) and have both planning and plan-persist re-export.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  readonly content: string;
  readonly status: PlanStatus;
}

/**
 * Mirror of `PlanUpdateContext` from @koi/middleware-planning. We accept
 * any superset of these fields — the planning middleware adds more (e.g.
 * `commitToken`) which we ignore.
 */
export interface PlanUpdateContextLike {
  readonly sessionId: string;
  readonly epoch: number;
  readonly turnIndex: number;
  readonly signal: AbortSignal;
}

/** Mirror of `OnPlanUpdate` from @koi/middleware-planning. */
export type OnPlanUpdate = (
  plan: readonly PlanItem[],
  context: PlanUpdateContextLike,
) => void | Promise<void>;
