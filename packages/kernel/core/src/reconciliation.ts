/**
 * Reconciliation contract — K8s-style desired-state convergence.
 *
 * Defines the extension point for L2 reconciliation controllers and the
 * configuration surface for the L1 reconcile runner. Controllers implement
 * `observe(actual) → diff(desired) → act()` loops that converge the system
 * to its declared desired state.
 *
 * Exception: DEFAULT_RECONCILE_RUNNER_CONFIG is a pure readonly data constant
 * derived from L0 type definitions, codifying architecture-doc invariants.
 */

import type { AgentManifest } from "./assembly.js";
import type { AgentId } from "./ecs.js";
import type { AgentRegistry } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Reconcile result — what the controller returns to the runner
// ---------------------------------------------------------------------------

/** Discriminated union describing the outcome of a single reconcile pass. */
export type ReconcileResult =
  | { readonly kind: "converged" }
  | { readonly kind: "retry"; readonly afterMs: number }
  | { readonly kind: "terminal"; readonly reason: string }
  | { readonly kind: "recheck"; readonly afterMs: number };

// ---------------------------------------------------------------------------
// Reconcile context — bag passed to controller.reconcile()
// ---------------------------------------------------------------------------

/** Read-only context provided to each reconciliation controller invocation. */
export interface ReconcileContext {
  readonly registry: AgentRegistry;
  readonly manifest: AgentManifest;
}

// ---------------------------------------------------------------------------
// Reconciliation controller — the extension point L2 packages implement
// ---------------------------------------------------------------------------

/**
 * A reconciliation controller observes actual state, diffs against desired
 * state (manifest), and returns an action result. The runner calls each
 * registered controller for every enqueued agent.
 *
 * Level-triggered: the controller re-reads current state on each invocation
 * rather than relying on edge-triggered event payloads.
 */
export interface ReconciliationController extends AsyncDisposable {
  readonly name: string;
  readonly reconcile: (
    agentId: AgentId,
    ctx: ReconcileContext,
  ) => ReconcileResult | Promise<ReconcileResult>;
}

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/** Configurable options for the reconcile runner processing loop. */
export interface ReconcileRunnerConfig {
  /** Interval between drift sweep scans of running agents (ms). Default: 60_000. */
  readonly driftCheckIntervalMs: number;
  /** Timeout for a single controller.reconcile() call (ms). Default: 30_000. */
  readonly reconcileTimeoutMs: number;
  /** Consecutive failures before circuit-breaking an agent+controller pair. Default: 5. */
  readonly maxConsecutiveFailures: number;
  /** Base delay for decorrelated jitter backoff (ms). Default: 100. */
  readonly backoffBaseMs: number;
  /** Maximum backoff cap (ms). Default: 30_000. */
  readonly backoffCapMs: number;
  /** Minimum interval between reconcile passes for the same agent (ms). Default: 5_000. */
  readonly minReconcileIntervalMs: number;
  /** Maximum concurrent async reconciles. 0 = unlimited. Default: 10. */
  readonly maxConcurrentReconciles: number;
}

/** Sensible defaults for the reconcile runner. */
export const DEFAULT_RECONCILE_RUNNER_CONFIG: ReconcileRunnerConfig = {
  driftCheckIntervalMs: 60_000,
  reconcileTimeoutMs: 30_000,
  maxConsecutiveFailures: 5,
  backoffBaseMs: 100,
  backoffCapMs: 30_000,
  minReconcileIntervalMs: 5_000,
  maxConcurrentReconciles: 10,
};
