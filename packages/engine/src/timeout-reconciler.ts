/**
 * Timeout reconciler — terminates agents that exceed a wall-clock budget.
 *
 * Uses `registeredAt` (wall-clock lifetime), not `lastTransitionAt`.
 * Suspended+resumed agents still accumulate time — this is intentional
 * as it represents a total budget for the agent's existence.
 */

import type {
  AgentId,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
} from "@koi/core";
import { isPromise } from "./is-promise.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TimeoutReconcilerConfig {
  /** Maximum wall-clock duration for an agent (ms). */
  readonly maxRunDurationMs: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Recheck ceiling (ms). Default: 30_000. */
  readonly recheckMs?: number;
  /** Optional callback returning the agent's last activity timestamp.
   *  When provided, timeout is measured from last activity (inactivity mode)
   *  instead of registeredAt (total budget mode). */
  readonly lastActivityAt?: (agentId: AgentId) => number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a timeout reconciler that terminates agents exceeding a wall-clock budget.
 *
 * @param deps.maxRunDurationMs - Maximum allowed agent lifetime in milliseconds.
 * @param deps.now - Injectable clock for tests (default: Date.now).
 * @param deps.recheckMs - Maximum recheck interval ceiling (default: 30_000ms).
 */
export function createTimeoutReconciler(deps: TimeoutReconcilerConfig): ReconciliationController {
  const now = deps.now ?? Date.now;
  const recheckMs = deps.recheckMs ?? 30_000;

  function reconcile(
    agentId: AgentId,
    ctx: ReconcileContext,
  ): ReconcileResult | Promise<ReconcileResult> {
    const entry = ctx.registry.lookup(agentId);

    if (entry === undefined) return { kind: "converged" };
    if (isPromise(entry)) {
      return entry.then((resolved) => {
        if (resolved === undefined) return { kind: "converged" } satisfies ReconcileResult;
        return reconcileEntry(agentId, ctx, resolved);
      });
    }

    return reconcileEntry(agentId, ctx, entry);
  }

  function reconcileEntry(
    agentId: AgentId,
    ctx: ReconcileContext,
    entry: NonNullable<Awaited<ReturnType<typeof ctx.registry.lookup>>>,
  ): ReconcileResult | Promise<ReconcileResult> {
    if (entry.status.phase !== "running") return { kind: "converged" };

    const activity = deps.lastActivityAt?.(agentId);
    const baseline = activity !== undefined ? activity : entry.registeredAt;
    const elapsed = now() - baseline;
    const remaining = deps.maxRunDurationMs - elapsed;

    if (remaining > 0) {
      // Not expired yet — recheck after remaining or recheckMs, whichever is smaller
      return { kind: "recheck", afterMs: Math.min(remaining, recheckMs) };
    }

    // Expired — CAS-transition to terminated
    const result = ctx.registry.transition(agentId, "terminated", entry.status.generation, {
      kind: "timeout",
    });

    if (!isPromise(result)) {
      if (!result.ok && result.error.code === "CONFLICT") {
        return { kind: "retry", afterMs: 100 };
      }
      return { kind: "converged" };
    }

    return result.then((r) => {
      if (!r.ok && r.error.code === "CONFLICT") {
        return { kind: "retry", afterMs: 100 } satisfies ReconcileResult;
      }
      return { kind: "converged" } satisfies ReconcileResult;
    });
  }

  return {
    name: "timeout-reconciler",
    reconcile,
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}
