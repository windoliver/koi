/**
 * Planning middleware types — plan items and configuration.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  readonly content: string;
  readonly status: PlanStatus;
}

/**
 * Identity tokens passed to onPlanUpdate so persistence backends can
 * key storage correctly and implement compare-and-swap semantics.
 *
 * - `sessionId` — which agent session the plan belongs to
 * - `epoch` — monotonic token assigned per onSessionStart; reused
 *   SessionIds (cycleSession/clear) get a fresh epoch. Hosts SHOULD
 *   reject writes whose epoch is not the current one for a SessionId
 *   so late-arriving stale writes cannot clobber a new session's
 *   durable state.
 * - `turnIndex` — the turn that emitted the write_plan call
 */
export interface PlanUpdateContext {
  readonly sessionId: string;
  readonly epoch: number;
  readonly turnIndex: number;
}

/**
 * Commit hook for a successful `write_plan` call. Runs before the
 * in-memory plan is exposed, so a sync throw or async rejection
 * causes the tool to report failure to the caller without any peer
 * turn ever seeing the uncommitted plan.
 *
 * The hook receives the plan plus a `PlanUpdateContext` so it can key
 * durable storage correctly. For multi-session backends, persistence
 * should compare-and-swap on `(sessionId, epoch)` so late-arriving
 * stale writes from a prior incarnation of the SessionId are dropped.
 */
export type OnPlanUpdate = (
  plan: readonly PlanItem[],
  context: PlanUpdateContext,
) => void | Promise<void>;

export interface PlanConfig {
  readonly onPlanUpdate?: OnPlanUpdate | undefined;
  /** Middleware priority (default: 450). */
  readonly priority?: number | undefined;
  /**
   * Whether to re-inject the current plan state into every subsequent
   * model request as a user-role reminder message. Defaults to true
   * (CC parity). Set to false when you need to suppress the replay
   * channel — e.g. when the host prefers to surface plan state
   * through its own UI/prompting path instead of having the agent
   * read its own prior output back as user-role text.
   */
  readonly injectPlanState?: boolean | undefined;
}
