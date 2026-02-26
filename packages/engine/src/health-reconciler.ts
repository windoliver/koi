/**
 * Health reconciler — terminates dead agents, monitors suspect ones.
 *
 * Integrates with the HealthMonitor to check agent liveness and
 * CAS-transitions dead agents to "terminated" with reason "stale".
 */

import type {
  AgentId,
  HealthMonitor,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
} from "@koi/core";
import { isPromise } from "./is-promise.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a health reconciler that terminates dead agents.
 *
 * @param deps.healthMonitor - Health monitor to check agent liveness.
 * @param deps.suspectRecheckMs - Recheck interval for suspect agents (default: 2500ms).
 */
export function createHealthReconciler(deps: {
  readonly healthMonitor: HealthMonitor;
  readonly suspectRecheckMs?: number;
}): ReconciliationController {
  const suspectRecheckMs = deps.suspectRecheckMs ?? 2_500;

  function reconcile(
    agentId: AgentId,
    ctx: ReconcileContext,
  ): ReconcileResult | Promise<ReconcileResult> {
    // Look up agent
    const entry = ctx.registry.lookup(agentId);

    // Handle sync registry (common case) vs async registry
    if (entry === undefined) return { kind: "converged" };
    if (isPromise(entry)) {
      return entry.then((resolved) => reconcileWithEntry(agentId, ctx, resolved));
    }

    return reconcileWithEntry(agentId, ctx, entry);
  }

  function reconcileWithEntry(
    agentId: AgentId,
    ctx: ReconcileContext,
    entry: Awaited<ReturnType<typeof ctx.registry.lookup>>,
  ): ReconcileResult | Promise<ReconcileResult> {
    if (entry === undefined) return { kind: "converged" };
    if (entry.status.phase === "terminated") return { kind: "converged" };

    // Only check health of running agents
    if (entry.status.phase !== "running") return { kind: "converged" };

    const snapshot = deps.healthMonitor.check(agentId);

    // Handle async health monitor (rare)
    if (isPromise(snapshot)) {
      return snapshot.then((s) =>
        handleHealthStatus(agentId, ctx, entry.status.generation, s.status),
      );
    }

    return handleHealthStatus(agentId, ctx, entry.status.generation, snapshot.status);
  }

  function handleHealthStatus(
    agentId: AgentId,
    ctx: ReconcileContext,
    generation: number,
    status: "alive" | "suspect" | "dead",
  ): ReconcileResult | Promise<ReconcileResult> {
    if (status === "alive") return { kind: "converged" };

    if (status === "suspect") {
      return { kind: "recheck", afterMs: suspectRecheckMs };
    }

    // Dead → terminate the agent (CAS-protected)
    const result = ctx.registry.transition(agentId, "terminated", generation, { kind: "stale" });

    // Handle sync registry
    if (!isPromise(result)) {
      if (!result.ok && result.error.code === "CONFLICT") {
        // Someone else already transitioned — retry to re-read state
        return { kind: "retry", afterMs: 100 };
      }
      return { kind: "converged" };
    }

    // Handle async registry
    return result.then((r) => {
      if (!r.ok && r.error.code === "CONFLICT") {
        return { kind: "retry", afterMs: 100 } satisfies ReconcileResult;
      }
      return { kind: "converged" } satisfies ReconcileResult;
    });
  }

  return {
    name: "health-reconciler",
    reconcile,
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}
