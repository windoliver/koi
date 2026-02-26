/**
 * Tool reconciler — detects missing tools and alerts.
 *
 * Compares the agent's manifest tool list against actually attached tools.
 * MVP: detect-and-alert only, no auto-repair (requires forge integration).
 * Forged (extra) tools are expected and not flagged.
 */

import type {
  AgentId,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
} from "@koi/core";
import { isPromise } from "./is-promise.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a tool reconciler that detects missing manifest tools.
 *
 * @param deps.getAttachedToolNames - Returns tool names attached to an agent.
 *   Injected so the reconciler is decoupled from the Agent entity internals.
 * @param deps.onMissingTools - Optional callback when tools are missing (alerting).
 */
export function createToolReconciler(deps: {
  readonly getAttachedToolNames: (
    agentId: AgentId,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly onMissingTools?: (agentId: AgentId, missing: readonly string[]) => void;
}): ReconciliationController {
  function reconcile(
    agentId: AgentId,
    ctx: ReconcileContext,
  ): ReconcileResult | Promise<ReconcileResult> {
    // Check if agent exists and isn't terminated
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

    const manifestTools = ctx.manifest.tools ?? [];
    if (manifestTools.length === 0) return { kind: "converged" };

    const expectedNames = manifestTools.map((t) => t.name);
    const attachedResult = deps.getAttachedToolNames(agentId);

    if (isPromise(attachedResult)) {
      return attachedResult.then((attached) => compareTools(agentId, expectedNames, attached));
    }

    return compareTools(agentId, expectedNames, attachedResult);
  }

  function compareTools(
    agentId: AgentId,
    expected: readonly string[],
    attached: readonly string[],
  ): ReconcileResult {
    const attachedSet = new Set(attached);
    const missing = expected.filter((name) => !attachedSet.has(name));

    if (missing.length === 0) return { kind: "converged" };

    // Alert: tools are missing
    deps.onMissingTools?.(agentId, missing);

    // Recheck after 10s to see if tools have been restored
    return { kind: "recheck", afterMs: 10_000 };
  }

  return {
    name: "tool-reconciler",
    reconcile,
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}
