/**
 * Supervision reconciler — Erlang/OTP-style restart strategies.
 *
 * Implements ReconciliationController to monitor supervised children and
 * apply restart strategies (one_for_one, one_for_all, rest_for_one) when
 * children terminate. Uses restart intensity tracking to prevent restart
 * storms; exhausted budgets escalate by terminating the supervisor.
 *
 * Design: level-triggered — re-reads current state on each reconcile,
 * not relying on edge-triggered event payloads.
 */

import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ChildSpec,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
  RegistryEntry,
  SupervisionConfig,
  TransitionReason,
} from "@koi/core";
import type { Clock } from "./clock.js";
import { createRealClock } from "./clock.js";
import { isPromise } from "./is-promise.js";
import type { ProcessTree } from "./process-tree.js";
import type { RestartIntensityTracker } from "./restart-intensity.js";
import { createRestartIntensityTracker } from "./restart-intensity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to spawn a new child agent and return its AgentId. */
export type SpawnChildFn = (
  parentId: AgentId,
  childSpec: ChildSpec,
  manifest: AgentManifest,
) => Promise<AgentId>;

/**
 * Extended reconciliation controller that also exposes whether a given
 * agent is a supervised child. CascadingTermination uses this to defer
 * cascading for supervised children (letting the reconciler handle restart).
 */
export interface SupervisionReconciler extends ReconciliationController {
  /** Returns true if the given agent ID is tracked as a supervised child. */
  readonly isSupervised: (agentId: AgentId) => boolean;
}

// ---------------------------------------------------------------------------
// Internal: per-supervisor state
// ---------------------------------------------------------------------------

interface SupervisorState {
  readonly tracker: RestartIntensityTracker;
  readonly spawnFailureTracker: RestartIntensityTracker;
  /** Maps child spec name → current AgentId (updated on restart). */
  readonly childMap: Map<string, AgentId>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSupervisionReconciler(deps: {
  readonly registry: AgentRegistry;
  readonly processTree: ProcessTree;
  readonly spawnChild: SpawnChildFn;
  readonly clock?: Clock;
}): SupervisionReconciler {
  const clock = deps.clock ?? createRealClock();
  const supervisorStates = new Map<string, SupervisorState>();

  /**
   * Set of all agent IDs currently tracked as supervised children.
   * CascadingTermination checks this to decide whether to defer cascading.
   * Updated in initializeChildMap (add), strategy functions (swap old→new),
   * and escalate/dispose (clear).
   */
  const supervisedChildIds = new Set<string>();

  /** Tracks which supervisors have had their child maps populated. */
  const initializedSupervisors = new Set<string>();
  const TERMINATE_CONFIRM_MAX_RETRIES = 3;
  const TERMINATE_CONFIRM_TIMEOUT_MS = 5_000;
  const REST_FOR_ONE_RETRY_BASE_MS = 250;
  const REST_FOR_ONE_RETRY_CAP_MS = 8_000;
  const REST_FOR_ONE_ROLLBACK_BUDGET_MS = 8_000;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getOrCreateState(agentId: AgentId, config: SupervisionConfig): SupervisorState {
    const existing = supervisorStates.get(agentId);
    if (existing !== undefined) return existing;

    const state: SupervisorState = {
      tracker: createRestartIntensityTracker({
        maxRestarts: config.maxRestarts,
        windowMs: config.maxRestartWindowMs,
        clock,
      }),
      spawnFailureTracker: createRestartIntensityTracker({
        maxRestarts: config.maxRestarts,
        windowMs: config.maxRestartWindowMs,
        clock,
      }),
      childMap: new Map(),
    };
    supervisorStates.set(agentId, state);
    return state;
  }

  /**
   * Initialize child map by matching process tree children to child specs.
   *
   * Matching strategy (two passes):
   * 1. Metadata-based: children spawned by a previous reconciler instance may
   *    have `metadata.childSpecName` set. This is the robust path and MUST be
   *    used when `spawnChild` implementations support it.
   * 2. Position-based fallback: children without metadata are assigned to
   *    unmatched specs in iteration order. WARNING: this fallback is unreliable
   *    after parallel restarts (one_for_all uses Promise.allSettled, so process
   *    tree insertion order may not match spec declaration order). SpawnChild
   *    implementations SHOULD set `metadata.childSpecName` to avoid mismatches.
   *
   * After matching, all matched child IDs are added to `supervisedChildIds`
   * so CascadingTermination knows to defer for them.
   */
  function initializeChildMap(
    agentId: AgentId,
    config: SupervisionConfig,
    state: SupervisorState,
  ): void {
    if (initializedSupervisors.has(agentId)) return;
    initializedSupervisors.add(agentId);

    const children = deps.processTree.childrenOf(agentId);
    const unmatchedChildren: AgentId[] = [];

    // Pass 1: match by metadata.childSpecName (robust)
    for (const childId of children) {
      const entry = deps.registry.lookup(childId);
      if (entry === undefined || isPromise(entry)) continue;

      const specName = entry.metadata.childSpecName;
      if (typeof specName === "string") {
        const specExists = config.children.some((c) => c.name === specName);
        if (specExists && !state.childMap.has(specName)) {
          state.childMap.set(specName, childId);
          supervisedChildIds.add(childId);
          continue;
        }
      }
      unmatchedChildren.push(childId);
    }

    // Pass 2: position-based fallback for children without metadata
    for (const childId of unmatchedChildren) {
      for (const spec of config.children) {
        if (!state.childMap.has(spec.name)) {
          state.childMap.set(spec.name, childId);
          supervisedChildIds.add(childId);
          break;
        }
      }
    }
  }

  /** Check if a terminated child should be restarted based on its restart type. */
  function shouldRestart(spec: ChildSpec, entry: RegistryEntry): boolean {
    if (spec.restart === "temporary") return false;
    if (spec.restart === "permanent") return true;

    // transient: restart only on abnormal termination
    const reason = entry.status.reason;
    if (reason === undefined) return false;
    return reason.kind === "error" || reason.kind === "stale";
  }

  /** Terminate a child with the given reason via CAS transition. */
  function terminateChild(childId: AgentId, reason: TransitionReason): boolean {
    const entry = deps.registry.lookup(childId);
    if (entry === undefined || isPromise(entry)) return false;
    if (entry.status.phase === "terminated") return true;

    const result = deps.registry.transition(childId, "terminated", entry.status.generation, reason);
    if (isPromise(result)) {
      // Fire and forget for async registries
      void (result as Promise<unknown>).catch((err: unknown) => {
        console.error(
          `[supervision-reconciler] async terminate failed for child "${childId}"`,
          err,
        );
      });
      return true;
    }
    return result.ok;
  }

  function computeRestForOneRetryDelay(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(REST_FOR_ONE_RETRY_BASE_MS * 2 ** exponent, REST_FOR_ONE_RETRY_CAP_MS);
  }

  async function awaitWithTimeout<T>(
    value: T | Promise<T>,
    timeoutMs: number,
  ): Promise<{
    readonly timedOut: boolean;
    readonly rejected: boolean;
    readonly value: T | undefined;
  }> {
    if (!isPromise(value)) return { timedOut: false, rejected: false, value };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        value
          .then((resolved) => ({
            timedOut: false as const,
            rejected: false as const,
            value: resolved,
          }))
          .catch(() => ({
            timedOut: false as const,
            rejected: true as const,
            value: undefined,
          })),
        new Promise<{
          readonly timedOut: true;
          readonly rejected: false;
          readonly value: undefined;
        }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ timedOut: true, rejected: false, value: undefined }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async function terminateChildConfirmed(
    childId: AgentId,
    reason: TransitionReason,
    deadlineAtMs: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < TERMINATE_CONFIRM_MAX_RETRIES; attempt++) {
      const remainingBudgetMs = deadlineAtMs - clock.now();
      if (remainingBudgetMs <= 0) return false;
      const timeoutMs = Math.max(1, Math.min(remainingBudgetMs, TERMINATE_CONFIRM_TIMEOUT_MS));

      const lookup = await awaitWithTimeout(deps.registry.lookup(childId), timeoutMs);
      if (lookup.timedOut || lookup.rejected) return false;
      const entry = lookup.value;
      if (entry === undefined) return true;
      if (entry.status.phase === "terminated") return true;

      const transitionRemainingMs = deadlineAtMs - clock.now();
      if (transitionRemainingMs <= 0) return false;
      const transitionTimeoutMs = Math.max(
        1,
        Math.min(transitionRemainingMs, TERMINATE_CONFIRM_TIMEOUT_MS),
      );
      const transition = await awaitWithTimeout(
        deps.registry.transition(childId, "terminated", entry.status.generation, reason),
        transitionTimeoutMs,
      );
      if (transition.timedOut || transition.rejected) return false;
      const result = transition.value;
      if (result === undefined) return false;
      if (result.ok) return true;
      if (result.error.code === "NOT_FOUND") return true;
      if (result.error.code !== "CONFLICT") return false;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Shared spawn helper (DRY: used by all 3 strategies)
  // ---------------------------------------------------------------------------

  /**
   * Spawns a child agent, registers it in the supervised set, and transitions
   * it to "running" with the appropriate restart reason.
   *
   * `attempt` is passed in by the caller rather than read from the tracker
   * inside. For `one_for_all` and `rest_for_one` strategies the set of
   * children being restarted is larger than the set whose failure triggered
   * the restart — reading the tracker here would report stale / zero
   * attempt numbers for children that were restarted for structural
   * (coupled) reasons rather than their own failure.
   */
  async function spawnAndTransition(
    parentId: AgentId,
    spec: ChildSpec,
    manifest: AgentManifest,
    state: SupervisorState,
    strategy: "one_for_one" | "one_for_all" | "rest_for_one",
    attempt: number,
  ): Promise<AgentId> {
    const newChildId = await deps.spawnChild(parentId, spec, manifest);
    state.childMap.set(spec.name, newChildId);
    supervisedChildIds.add(newChildId);

    const entry = deps.registry.lookup(newChildId);
    if (entry !== undefined && !isPromise(entry)) {
      const reason: TransitionReason = {
        kind: "restarted",
        attempt,
        strategy,
      };
      deps.registry.transition(newChildId, "running", entry.status.generation, reason);
    }
    return newChildId;
  }

  // ---------------------------------------------------------------------------
  // Strategy implementations
  // ---------------------------------------------------------------------------

  async function applyOneForOne(
    parentId: AgentId,
    _config: SupervisionConfig,
    state: SupervisorState,
    terminatedSpecs: readonly ChildSpec[],
    manifest: AgentManifest,
  ): Promise<ReconcileResult> {
    for (const spec of terminatedSpecs) {
      // Check exhaustion BEFORE recording — Erlang semantics: maxRestarts
      // restarts are allowed, the (maxRestarts+1)th triggers escalation
      if (state.tracker.isExhausted(spec.name)) {
        return escalate(parentId, spec.name);
      }

      state.tracker.record(spec.name);
      const attempt = state.tracker.attemptsInWindow(spec.name);

      // Remove old child from supervised set before spawning replacement
      const oldChildId = state.childMap.get(spec.name);
      if (oldChildId !== undefined) supervisedChildIds.delete(oldChildId);
      try {
        await spawnAndTransition(parentId, spec, manifest, state, "one_for_one", attempt);
      } catch (err: unknown) {
        // Roll back this spec's attempt record when the replacement spawn
        // itself failed; otherwise repeated spawn failures can exhaust the
        // restart budget without ever producing a live replacement.
        state.tracker.unrecord(spec.name);
        throw err;
      }
    }
    return { kind: "converged" };
  }

  async function applyOneForAll(
    parentId: AgentId,
    config: SupervisionConfig,
    state: SupervisorState,
    terminatedSpecs: readonly ChildSpec[],
    manifest: AgentManifest,
  ): Promise<ReconcileResult> {
    // Check exhaustion BEFORE recording — Erlang semantics
    for (const spec of terminatedSpecs) {
      if (state.tracker.isExhausted(spec.name)) {
        return escalate(parentId, spec.name);
      }
      state.tracker.record(spec.name);
    }

    // Compute the per-spec attempt number ONCE, after recording. Children
    // that failed carry their true attempt count; coupled-restart siblings
    // (not in terminatedSpecs) carry 0 since they weren't part of the
    // failure event.
    const terminatedSet = new Set(terminatedSpecs.map((s) => s.name));
    const attemptOf = (specName: string): number =>
      terminatedSet.has(specName) ? state.tracker.attemptsInWindow(specName) : 0;

    // Terminate ALL non-terminated children and remove from supervised set
    for (const spec of config.children) {
      const childId = state.childMap.get(spec.name);
      if (childId === undefined) continue;
      supervisedChildIds.delete(childId);
      terminateChild(childId, {
        kind: "restarted",
        attempt: attemptOf(spec.name),
        strategy: "one_for_all",
      });
    }

    // Restart all children in parallel (one_for_all = tightly coupled, no ordering dependency)
    const results: readonly PromiseSettledResult<AgentId>[] = await Promise.allSettled(
      config.children.map((childSpec: ChildSpec) =>
        spawnAndTransition(
          parentId,
          childSpec,
          manifest,
          state,
          "one_for_all",
          attemptOf(childSpec.name),
        ),
      ),
    );

    // Handle partial failure: if any spawn failed, terminate the successful ones and escalate
    const failures = results.filter(
      (result: PromiseSettledResult<AgentId>): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failures.length > 0) {
      // Rollback: terminate successfully spawned children so the registry
      // doesn't carry half-restarted state into the next reconcile pass.
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const spec = config.children[i];
        if (result?.status === "fulfilled" && spec !== undefined) {
          supervisedChildIds.delete(result.value);
          terminateChild(result.value, {
            kind: "restarted",
            attempt: attemptOf(spec.name),
            strategy: "one_for_all",
          });
        }
      }
      // Roll back intensity accounting for the triggering failed specs. The
      // one_for_all cycle never converged to a new stable child set, so these
      // should not consume restart budget permanently.
      for (const spec of terminatedSpecs) {
        state.tracker.unrecord(spec.name);
      }
      // Surface the first failure
      throw failures[0]?.reason;
    }

    return { kind: "converged" };
  }

  async function applyRestForOne(
    parentId: AgentId,
    config: SupervisionConfig,
    state: SupervisorState,
    terminatedSpecs: readonly ChildSpec[],
    manifest: AgentManifest,
  ): Promise<ReconcileResult> {
    // Cache per-reconcile spec-name → index map so `specIndex` is O(1)
    // instead of O(N) per lookup.
    const indexByName = new Map<string, number>();
    for (let i = 0; i < config.children.length; i++) {
      const spec = config.children[i];
      if (spec !== undefined) indexByName.set(spec.name, i);
    }

    // Find the earliest failed child in declaration order
    let earliestIdx = config.children.length;
    for (const spec of terminatedSpecs) {
      // Check exhaustion BEFORE recording — Erlang semantics
      if (state.tracker.isExhausted(spec.name)) {
        return escalate(parentId, spec.name);
      }
      if (state.spawnFailureTracker.isExhausted(spec.name)) {
        return escalate(parentId, spec.name);
      }
      state.tracker.record(spec.name);

      const idx = indexByName.get(spec.name) ?? -1;
      if (idx >= 0 && idx < earliestIdx) {
        earliestIdx = idx;
      }
    }

    const terminatedSet = new Set(terminatedSpecs.map((s) => s.name));
    const attemptOf = (specName: string): number =>
      terminatedSet.has(specName) ? state.tracker.attemptsInWindow(specName) : 0;

    // Terminate children from earliestIdx onward (in reverse to be safe)
    // and remove from supervised set
    for (let i = config.children.length - 1; i >= earliestIdx; i--) {
      const spec = config.children[i];
      if (spec === undefined) continue;
      const childId = state.childMap.get(spec.name);
      if (childId === undefined) continue;
      supervisedChildIds.delete(childId);
      terminateChild(childId, {
        kind: "restarted",
        attempt: attemptOf(spec.name),
        strategy: "rest_for_one",
      });
    }

    const restartedSpecs: ChildSpec[] = [];
    let failedSpec: ChildSpec | undefined;
    try {
      // Restart from earliestIdx onward in declaration order
      // (rest_for_one preserves ordering — sequential spawn is intentional)
      for (let i = earliestIdx; i < config.children.length; i++) {
        const spec = config.children[i];
        if (spec === undefined) continue;
        failedSpec = spec;
        await spawnAndTransition(
          parentId,
          spec,
          manifest,
          state,
          "rest_for_one",
          attemptOf(spec.name),
        );
        restartedSpecs.push(spec);
        failedSpec = undefined;
      }
      // Successful cycle clears spawn-failure streaks for this restart set.
      for (const spec of restartedSpecs) {
        state.spawnFailureTracker.reset(spec.name);
      }
      return { kind: "converged" };
    } catch (err: unknown) {
      console.error(
        `[supervision-reconciler] rest_for_one restart cycle failed for supervisor "${parentId}"`,
        err,
      );
      // Roll back any partial rest_for_one restart set so the next reconcile
      // starts from a consistent "all affected children terminated" state.
      const rollbackDeadlineAt = clock.now() + REST_FOR_ONE_ROLLBACK_BUDGET_MS;
      let rollbackConfirmed = true;
      for (let i = restartedSpecs.length - 1; i >= 0; i--) {
        if (clock.now() >= rollbackDeadlineAt) {
          rollbackConfirmed = false;
          break;
        }
        const spec = restartedSpecs[i];
        if (spec === undefined) continue;
        const restartedChildId = state.childMap.get(spec.name);
        if (restartedChildId === undefined) continue;
        const terminated = await terminateChildConfirmed(
          restartedChildId,
          {
            kind: "restarted",
            attempt: attemptOf(spec.name),
            strategy: "rest_for_one",
          },
          rollbackDeadlineAt,
        );
        if (terminated) {
          supervisedChildIds.delete(restartedChildId);
        } else {
          rollbackConfirmed = false;
        }
      }
      if (!rollbackConfirmed) {
        // This restart cycle did not converge and rollback is uncertain.
        // Do not burn restart budget for triggering specs yet.
        for (const spec of terminatedSpecs) {
          state.tracker.unrecord(spec.name);
        }
        return {
          kind: "retry",
          afterMs: computeRestForOneRetryDelay(1),
        };
      }
      // Roll back intensity accounting for triggering specs because the cycle
      // did not converge to a stable replacement set.
      for (const spec of terminatedSpecs) {
        state.tracker.unrecord(spec.name);
      }
      if (failedSpec !== undefined) {
        if (state.spawnFailureTracker.isExhausted(failedSpec.name)) {
          return escalate(parentId, failedSpec.name);
        }
        state.spawnFailureTracker.record(failedSpec.name);
        const failureAttempt = state.spawnFailureTracker.attemptsInWindow(failedSpec.name);
        return {
          kind: "retry",
          afterMs: computeRestForOneRetryDelay(failureAttempt),
        };
      }
      return {
        kind: "retry",
        afterMs: computeRestForOneRetryDelay(1),
      };
    }
  }

  /** Escalate: terminate the supervisor itself and remove its children from supervised set. */
  function escalate(supervisorId: AgentId, failedChild: string): ReconcileResult {
    // Remove all children of this supervisor from the supervised set
    const state = supervisorStates.get(supervisorId);
    if (state !== undefined) {
      for (const childId of state.childMap.values()) {
        supervisedChildIds.delete(childId);
      }
    }

    const entry = deps.registry.lookup(supervisorId);
    if (entry !== undefined && !isPromise(entry) && entry.status.phase !== "terminated") {
      const reason: TransitionReason = {
        kind: "escalated",
        cause: `Restart budget exhausted for child "${failedChild}"`,
      };
      deps.registry.transition(supervisorId, "terminated", entry.status.generation, reason);
    }
    return { kind: "terminal", reason: `Escalated: restart budget exhausted for "${failedChild}"` };
  }

  // ---------------------------------------------------------------------------
  // Main reconcile loop
  // ---------------------------------------------------------------------------

  async function reconcile(agentId: AgentId, ctx: ReconcileContext): Promise<ReconcileResult> {
    const config = ctx.manifest.supervision;

    // Early return for unsupervised agents
    if (config === undefined) return { kind: "converged" };
    if (config.children.length === 0) return { kind: "converged" };

    // Check supervisor is still alive
    const supervisorEntry = await deps.registry.lookup(agentId);
    if (supervisorEntry === undefined) return { kind: "converged" };
    if (supervisorEntry.status.phase === "terminated") {
      // Clean up supervised children tracking for this supervisor
      const state = supervisorStates.get(agentId);
      if (state !== undefined) {
        for (const childId of state.childMap.values()) {
          supervisedChildIds.delete(childId);
        }
      }
      supervisorStates.delete(agentId);
      initializedSupervisors.delete(agentId);
      return { kind: "converged" };
    }

    const state = getOrCreateState(agentId, config);
    initializeChildMap(agentId, config, state);

    // Find terminated children that need restart
    const terminatedSpecs: ChildSpec[] = [];
    for (const spec of config.children) {
      const childId = state.childMap.get(spec.name);
      if (childId === undefined) {
        // Child not yet spawned or was deregistered — treat as needing restart
        // (unless temporary)
        if (spec.restart !== "temporary") {
          terminatedSpecs.push(spec);
        }
        continue;
      }

      const childEntry = await deps.registry.lookup(childId);
      if (childEntry === undefined) {
        // Deregistered — needs restart (unless temporary)
        if (spec.restart !== "temporary") {
          terminatedSpecs.push(spec);
        }
        continue;
      }

      if (childEntry.status.phase === "terminated") {
        if (shouldRestart(spec, childEntry)) {
          terminatedSpecs.push(spec);
        }
      }
    }

    // Nothing to restart — converged
    if (terminatedSpecs.length === 0) return { kind: "converged" };

    // Apply the strategy
    switch (config.strategy.kind) {
      case "one_for_one":
        return applyOneForOne(agentId, config, state, terminatedSpecs, ctx.manifest);
      case "one_for_all":
        return applyOneForAll(agentId, config, state, terminatedSpecs, ctx.manifest);
      case "rest_for_one":
        return applyRestForOne(agentId, config, state, terminatedSpecs, ctx.manifest);
    }
  }

  // ---------------------------------------------------------------------------
  // Controller interface
  // ---------------------------------------------------------------------------

  return {
    name: "supervision-reconciler",
    reconcile,
    isSupervised: (agentId: AgentId): boolean => supervisedChildIds.has(agentId),
    async [Symbol.asyncDispose](): Promise<void> {
      supervisorStates.clear();
      supervisedChildIds.clear();
      initializedSupervisors.clear();
    },
  };
}
