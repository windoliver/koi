/**
 * Terminated-agent sweeper — deregisters terminated agents after a TTL.
 *
 * `InMemoryRegistry` keeps terminated entries forever unless someone calls
 * `deregister()`. In a long-running runtime that spawns many short-lived
 * agents (scheduler dispatches, supervised child restarts, task-tool
 * subagents) the entries accumulate, slowly leaking memory.
 *
 * Runs as a ReconciliationController: on each reconcile pass for an agent,
 * if `phase === "terminated"` and `now - lastTransitionAt >= ttlMs`, it
 * calls `registry.deregister(id)` and returns "converged". Otherwise it
 * requests a recheck so the entry is revisited once the TTL has elapsed.
 *
 * Cross-reference: hermes-agent's `FINISHED_TTL_SECONDS = 1800` in
 * `tools/process_registry.py` applies the same policy at the process-
 * registry layer.
 */

import type {
  AgentId,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
} from "@koi/core";
import type { Clock } from "./clock.js";
import { createRealClock } from "./clock.js";
import { isPromise } from "./is-promise.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TerminatedSweeperConfig {
  /**
   * How long to retain a terminated entry before deregistering it.
   * Default: 30 minutes — long enough for observers/reporters to read the
   * final status, short enough to prevent unbounded growth.
   */
  readonly ttlMs?: number | undefined;
  /** Injectable clock for tests. */
  readonly clock?: Clock | undefined;
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reconciliation controller that auto-deregisters terminated
 * agents after `ttlMs` has elapsed since their last transition.
 *
 * Wire it alongside the other reconcilers via `ReconcileRunner.register`.
 * The drift sweep will revisit terminated agents periodically; this
 * controller returns "recheck" until the TTL matures, then "converged"
 * after calling `deregister`.
 */
export function createTerminatedSweeper(
  config?: TerminatedSweeperConfig,
): ReconciliationController {
  const clock = config?.clock ?? createRealClock();
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;

  function reconcile(
    agentId: AgentId,
    ctx: ReconcileContext,
  ): ReconcileResult | Promise<ReconcileResult> {
    const entry = ctx.registry.lookup(agentId);
    if (isPromise(entry)) {
      return entry.then((resolved) => evaluate(agentId, ctx, resolved));
    }
    return evaluate(agentId, ctx, entry);
  }

  function evaluate(
    agentId: AgentId,
    ctx: ReconcileContext,
    entry: Awaited<ReturnType<typeof ctx.registry.lookup>>,
  ): ReconcileResult {
    // Already gone — nothing to do.
    if (entry === undefined) return { kind: "converged" };
    // Only terminated entries are eligible for TTL eviction.
    if (entry.status.phase !== "terminated") return { kind: "converged" };

    const elapsed = clock.now() - entry.status.lastTransitionAt;
    if (elapsed >= ttlMs) {
      // Fire-and-forget for async registries. The deregister event will
      // clean up any sibling trackers (process-tree, health-monitor, etc.).
      const result = ctx.registry.deregister(agentId);
      if (isPromise(result)) {
        void result.catch((err: unknown) => {
          console.error(`[terminated-sweeper] async deregister failed for "${agentId}"`, err);
        });
      }
      return { kind: "converged" };
    }

    // Revisit when the TTL is due. Upper-bound the recheck delay so a very
    // large ttlMs doesn't hold a multi-hour timer open — the drift sweep
    // will re-enqueue eventually, but this is cheaper and more responsive.
    const wait = Math.max(1, Math.min(ttlMs - elapsed, 60_000));
    return { kind: "recheck", afterMs: wait };
  }

  return {
    name: "koi:terminated-sweeper",
    reconcile,
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}
