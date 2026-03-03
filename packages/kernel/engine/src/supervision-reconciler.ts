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
   *    have `metadata.childSpecName` set. This is the robust path.
   * 2. Position-based fallback: children without metadata are assigned to
   *    unmatched specs in iteration order. This is safe because all strategy
   *    functions spawn children sequentially in declaration order, so the
   *    process tree's insertion order mirrors the spec list.
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
      void result;
      return true;
    }
    return result.ok;
  }

  /** Find the index of a child spec by name. */
  function specIndex(config: SupervisionConfig, specName: string): number {
    return config.children.findIndex((c) => c.name === specName);
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

      const newChildId = await deps.spawnChild(parentId, spec, manifest);
      state.childMap.set(spec.name, newChildId);
      supervisedChildIds.add(newChildId);

      // Transition to running with restart reason
      const entry = deps.registry.lookup(newChildId);
      if (entry !== undefined && !isPromise(entry)) {
        const reason: TransitionReason = {
          kind: "restarted",
          attempt,
          strategy: "one_for_one",
        };
        deps.registry.transition(newChildId, "running", entry.status.generation, reason);
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

    // Terminate ALL non-terminated children and remove from supervised set
    for (const spec of config.children) {
      const childId = state.childMap.get(spec.name);
      if (childId === undefined) continue;
      supervisedChildIds.delete(childId);
      terminateChild(childId, { kind: "restarted", attempt: 0, strategy: "one_for_all" });
    }

    // Restart all children in declaration order
    for (const spec of config.children) {
      const attempt = state.tracker.attemptsInWindow(spec.name);
      const newChildId = await deps.spawnChild(parentId, spec, manifest);
      state.childMap.set(spec.name, newChildId);
      supervisedChildIds.add(newChildId);

      const entry = deps.registry.lookup(newChildId);
      if (entry !== undefined && !isPromise(entry)) {
        const reason: TransitionReason = {
          kind: "restarted",
          attempt,
          strategy: "one_for_all",
        };
        deps.registry.transition(newChildId, "running", entry.status.generation, reason);
      }
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
    // Find the earliest failed child in declaration order
    let earliestIdx = config.children.length;
    for (const spec of terminatedSpecs) {
      // Check exhaustion BEFORE recording — Erlang semantics
      if (state.tracker.isExhausted(spec.name)) {
        return escalate(parentId, spec.name);
      }
      state.tracker.record(spec.name);

      const idx = specIndex(config, spec.name);
      if (idx >= 0 && idx < earliestIdx) {
        earliestIdx = idx;
      }
    }

    // Terminate children from earliestIdx onward (in reverse to be safe)
    // and remove from supervised set
    for (let i = config.children.length - 1; i >= earliestIdx; i--) {
      const spec = config.children[i];
      if (spec === undefined) continue;
      const childId = state.childMap.get(spec.name);
      if (childId === undefined) continue;
      supervisedChildIds.delete(childId);
      terminateChild(childId, { kind: "restarted", attempt: 0, strategy: "rest_for_one" });
    }

    // Restart from earliestIdx onward in declaration order
    for (let i = earliestIdx; i < config.children.length; i++) {
      const spec = config.children[i];
      if (spec === undefined) continue;
      const attempt = state.tracker.attemptsInWindow(spec.name);
      const newChildId = await deps.spawnChild(parentId, spec, manifest);
      state.childMap.set(spec.name, newChildId);
      supervisedChildIds.add(newChildId);

      const entry = deps.registry.lookup(newChildId);
      if (entry !== undefined && !isPromise(entry)) {
        const reason: TransitionReason = {
          kind: "restarted",
          attempt,
          strategy: "rest_for_one",
        };
        deps.registry.transition(newChildId, "running", entry.status.generation, reason);
      }
    }
    return { kind: "converged" };
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
