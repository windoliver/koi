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
const IN_FLIGHT_RECHECK_MS = 1_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRY_JITTER_RATIO = 0.2;
const RETRY_CAP_ATTEMPTS = 8;
const ASYNC_DEREGISTER_TIMEOUT_MS = 10_000;
type RetrySchedule = Extract<
  ReconcileResult,
  { readonly kind: "retry" } | { readonly kind: "recheck" }
>;

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
  const failedAttempts = new Map<string, number>();
  const nextRetryAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const inFlightStartedAt = new Map<string, number>();
  const inFlightToken = new Map<string, number>();
  let tokenCounter = 0;

  function clearRetryState(agentId: AgentId): void {
    failedAttempts.delete(agentId);
    nextRetryAt.delete(agentId);
    inFlight.delete(agentId);
    inFlightStartedAt.delete(agentId);
    inFlightToken.delete(agentId);
  }

  function computeRetryDelay(agentId: AgentId, attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const baseDelay = Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
    const jitterSpan = Math.floor(baseDelay * RETRY_JITTER_RATIO);
    if (jitterSpan === 0) return baseDelay;
    // Deterministic jitter avoids thundering herds without introducing test flakes.
    const seed = `${agentId}:${String(attempt)}`;
    let hash = 0;
    for (const ch of seed) {
      hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
    }
    const jitter = (hash % (jitterSpan * 2 + 1)) - jitterSpan;
    return Math.max(1, baseDelay + jitter);
  }

  function scheduleRetry(agentId: AgentId): RetrySchedule {
    const attempt = (failedAttempts.get(agentId) ?? 0) + 1;
    failedAttempts.set(agentId, attempt);
    if (attempt >= RETRY_CAP_ATTEMPTS) {
      nextRetryAt.set(agentId, clock.now() + RETRY_MAX_MS);
      return { kind: "recheck", afterMs: RETRY_MAX_MS };
    }
    const delay = computeRetryDelay(agentId, attempt);
    nextRetryAt.set(agentId, clock.now() + delay);
    return { kind: "retry", afterMs: delay };
  }

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
  ): ReconcileResult | Promise<ReconcileResult> {
    // Already gone — nothing to do.
    if (entry === undefined) {
      clearRetryState(agentId);
      return { kind: "converged" };
    }
    // Only terminated entries are eligible for TTL eviction.
    if (entry.status.phase !== "terminated") {
      clearRetryState(agentId);
      return { kind: "converged" };
    }

    const elapsed = clock.now() - entry.status.lastTransitionAt;
    if (elapsed >= ttlMs) {
      if (inFlight.has(agentId)) {
        const startedAt = inFlightStartedAt.get(agentId) ?? clock.now();
        const elapsedInFlight = clock.now() - startedAt;
        if (elapsedInFlight < ASYNC_DEREGISTER_TIMEOUT_MS) {
          const wait = Math.max(1, ASYNC_DEREGISTER_TIMEOUT_MS - elapsedInFlight);
          return { kind: "recheck", afterMs: wait };
        }
        console.warn(
          `[terminated-sweeper] async deregister timed out for "${agentId}" after ${ASYNC_DEREGISTER_TIMEOUT_MS}ms`,
        );
        // Expire lease and allow a fresh attempt on a later pass. Completion
        // callbacks from the stale token are ignored.
        inFlight.delete(agentId);
        inFlightStartedAt.delete(agentId);
        inFlightToken.delete(agentId);
        const scheduled = scheduleRetry(agentId);
        return { kind: "recheck", afterMs: scheduled.afterMs };
      }

      const retryAt = nextRetryAt.get(agentId);
      if (retryAt !== undefined) {
        const remaining = retryAt - clock.now();
        if (remaining > 0) {
          return { kind: "recheck", afterMs: Math.max(1, remaining) };
        }
      }

      const result = ctx.registry.deregister(agentId);
      if (isPromise(result)) {
        const token = ++tokenCounter;
        inFlight.add(agentId);
        inFlightStartedAt.set(agentId, clock.now());
        inFlightToken.set(agentId, token);
        nextRetryAt.delete(agentId);
        void result
          .then((removed) => {
            if (inFlightToken.get(agentId) !== token) return;
            if (removed) {
              clearRetryState(agentId);
              return;
            }
            scheduleRetry(agentId);
          })
          .catch((err: unknown) => {
            if (inFlightToken.get(agentId) !== token) return;
            console.error(`[terminated-sweeper] async deregister failed for "${agentId}"`, err);
            scheduleRetry(agentId);
          })
          .finally(() => {
            if (inFlightToken.get(agentId) !== token) return;
            inFlight.delete(agentId);
            inFlightStartedAt.delete(agentId);
            inFlightToken.delete(agentId);
          });
        return { kind: "recheck", afterMs: IN_FLIGHT_RECHECK_MS };
      }
      if (!result) {
        return scheduleRetry(agentId);
      }
      clearRetryState(agentId);
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
