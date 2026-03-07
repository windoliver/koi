/**
 * Reconcile runner — orchestrates reconciliation controllers in a background loop.
 *
 * This is Koi's equivalent of systemd's supervision controller. It watches the
 * agent registry for state changes and runs pluggable ReconciliationControllers
 * (health, governance, supervision) to converge agents toward their desired state.
 *
 * Linux analogy:
 *   systemd       → ReconcileRunner (this module)
 *   unit files    → AgentManifest
 *   cgroup events → registry.watch() events
 *   restart logic → ReconciliationController implementations
 *
 * Event-driven fast path: subscribes to registry.watch() for immediate reaction.
 * Drift sweep slow path: periodic scan of running agents to catch missed events.
 * K8s three-data-structure queue: dedup + dirty tracking for concurrent events.
 * Circuit breaker: stops reconciling after N consecutive failures per agent+controller.
 *
 * Design note: processTick is sync-first. When a controller returns a sync result,
 * it is handled immediately in the same tick (critical for FakeClock testability).
 * Async results (Promises) are handled via fire-and-forget with timeout.
 */

import type {
  AgentId,
  AgentManifest,
  AgentRegistry,
  ReconcileResult,
  ReconcileRunnerConfig,
  ReconciliationController,
} from "@koi/core";
import { DEFAULT_RECONCILE_RUNNER_CONFIG } from "@koi/core";
import { computeBackoff } from "./backoff.js";
import type { Clock, TimerHandle } from "./clock.js";
import { createRealClock } from "./clock.js";
import { isPromise } from "./is-promise.js";
import { createReconcileQueue } from "./reconcile-queue.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileRunnerStats {
  readonly totalReconciled: number;
  readonly totalRetried: number;
  readonly totalCircuitBroken: number;
  readonly queueSize: number;
  readonly activeControllers: number;
  readonly inFlightAsyncReconciles: number;
}

export interface ReconcileRunner extends AsyncDisposable {
  /** Begin processing the reconcile queue and drift sweep. */
  readonly start: () => void;
  /** Register a reconciliation controller. */
  readonly register: (controller: ReconciliationController) => void;
  /** Force-enqueue all running agents, bypassing minReconcileIntervalMs. */
  readonly sweep: () => void;
  /** Get current runner statistics. */
  readonly stats: () => ReconcileRunnerStats;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReconcileRunner(deps: {
  readonly registry: AgentRegistry;
  readonly manifests: ReadonlyMap<string, AgentManifest>;
  readonly clock?: Clock;
  readonly config?: Partial<ReconcileRunnerConfig>;
}): ReconcileRunner {
  const clock = deps.clock ?? createRealClock();
  const config: ReconcileRunnerConfig = { ...DEFAULT_RECONCILE_RUNNER_CONFIG, ...deps.config };
  const queue = createReconcileQueue<AgentId>();
  const controllers: ReconciliationController[] = []; // let-equivalent: push on register

  // --- Stats ---
  let totalReconciled = 0; // let: incremented on successful reconcile
  let totalRetried = 0; // let: incremented on retry result
  let totalCircuitBroken = 0; // let: incremented on circuit break
  let inFlightCount = 0; // let: incremented/decremented for async concurrency cap

  // --- Circuit breaker: "agentId:controllerName" → consecutive failure count ---
  const consecutiveFailures = new Map<string, number>();

  // --- Backoff state: "agentId:controllerName" → last sleep ms ---
  const backoffState = new Map<string, number>();

  // --- Last reconcile timestamp per agent (for drift sweep skip) ---
  const lastReconciledAt = new Map<string, number>();

  // --- Timer handles for cleanup ---
  const backoffTimers = new Map<string, TimerHandle>();
  let driftSweepTimer: TimerHandle | undefined; // let: set on start()
  let processTickTimer: TimerHandle | undefined; // let: set on start()
  let disposed = false; // let: set on dispose

  // --- Watch subscription ---
  const unwatchRegistry = deps.registry.watch((event) => {
    if (disposed) return;

    if (event.kind === "registered") {
      queue.enqueue(event.entry.agentId);
      resetCircuitBreaker(event.entry.agentId);
    } else if (event.kind === "transitioned") {
      queue.enqueue(event.agentId);
      resetCircuitBreaker(event.agentId);
    } else if (event.kind === "deregistered") {
      queue.remove(event.agentId);
      cleanupAgent(event.agentId);
    }
  });

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function circuitKey(agentId: AgentId, controllerName: string): string {
    return `${agentId}:${controllerName}`;
  }

  function resetCircuitBreaker(agentId: AgentId): void {
    for (const controller of controllers) {
      const key = circuitKey(agentId, controller.name);
      consecutiveFailures.delete(key);
      backoffState.delete(key);
    }
  }

  function cleanupAgent(agentId: AgentId): void {
    for (const controller of controllers) {
      const key = circuitKey(agentId, controller.name);
      consecutiveFailures.delete(key);
      backoffState.delete(key);
      const timer = backoffTimers.get(key);
      if (timer !== undefined) {
        timer.clear();
        backoffTimers.delete(key);
      }
    }
    lastReconciledAt.delete(agentId);
  }

  // ---------------------------------------------------------------------------
  // Result handling (shared between sync and async paths)
  // ---------------------------------------------------------------------------

  function handleResult(agentId: AgentId, key: string, result: ReconcileResult): void {
    switch (result.kind) {
      case "converged": {
        consecutiveFailures.delete(key);
        backoffState.delete(key);
        totalReconciled += 1;
        break;
      }
      case "retry": {
        totalRetried += 1;
        consecutiveFailures.delete(key);
        const timerHandle = clock.setTimeout(() => {
          if (!disposed) queue.enqueue(agentId);
          backoffTimers.delete(key);
        }, result.afterMs);
        backoffTimers.set(key, timerHandle);
        break;
      }
      case "terminal": {
        consecutiveFailures.delete(key);
        backoffState.delete(key);
        totalReconciled += 1;
        break;
      }
      case "recheck": {
        totalReconciled += 1;
        consecutiveFailures.delete(key);
        const recheckHandle = clock.setTimeout(() => {
          if (!disposed) queue.enqueue(agentId);
          backoffTimers.delete(key);
        }, result.afterMs);
        backoffTimers.set(key, recheckHandle);
        break;
      }
    }
  }

  function handleError(agentId: AgentId, key: string): void {
    const prevSleep = backoffState.get(key) ?? 0;
    const nextSleep = computeBackoff(prevSleep, config.backoffBaseMs, config.backoffCapMs);
    backoffState.set(key, nextSleep);

    const newFailures = (consecutiveFailures.get(key) ?? 0) + 1;
    consecutiveFailures.set(key, newFailures);

    if (newFailures >= config.maxConsecutiveFailures) {
      totalCircuitBroken += 1;
    } else {
      totalRetried += 1;
      const failHandle = clock.setTimeout(() => {
        if (!disposed) queue.enqueue(agentId);
        backoffTimers.delete(key);
      }, nextSleep);
      backoffTimers.set(key, failHandle);
    }
  }

  // ---------------------------------------------------------------------------
  // Async reconcile with timeout (for controllers returning Promises)
  // ---------------------------------------------------------------------------

  function handleAsyncReconcile(
    agentId: AgentId,
    controller: ReconciliationController,
    resultPromise: Promise<ReconcileResult>,
  ): void {
    // Per-call guard: a single processTick may iterate multiple async controllers
    const max = config.maxConcurrentReconciles;
    if (max > 0 && inFlightCount >= max) {
      queue.enqueue(agentId);
      return;
    }

    inFlightCount += 1;
    const key = circuitKey(agentId, controller.name);

    let timeoutHandle: TimerHandle | undefined; // let: set in Promise constructor, cleared on resolve
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = clock.setTimeout(
        () => reject(new Error("Reconcile timeout")),
        config.reconcileTimeoutMs,
      );
    });

    void Promise.race([resultPromise, timeoutPromise]).then(
      (result) => {
        inFlightCount -= 1;
        timeoutHandle?.clear(); // prevent timer leak on success
        handleResult(agentId, key, result);
      },
      (err: unknown) => {
        inFlightCount -= 1;
        console.error(
          `[reconcile-runner] async controller "${controller.name}" failed for agent "${agentId}"`,
          err,
        );
        handleError(agentId, key);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Drift sweep — periodic scan of running agents
  // ---------------------------------------------------------------------------

  function driftSweep(): void {
    if (disposed) return;

    const listed = deps.registry.list({ phase: "running" });

    // Handle sync registry (InMemoryRegistry) — common case
    if (!isPromise(listed)) {
      const now = clock.now();
      for (const e of listed) {
        const lastTime = lastReconciledAt.get(e.agentId);
        if (lastTime !== undefined && now - lastTime < config.minReconcileIntervalMs) {
          continue;
        }
        queue.enqueue(e.agentId);
      }
      return;
    }

    // Async registry (rare — network-backed)
    void listed
      .then((entries) => {
        if (disposed) return;
        const now = clock.now();
        for (const e of entries) {
          const lastTime = lastReconciledAt.get(e.agentId);
          if (lastTime !== undefined && now - lastTime < config.minReconcileIntervalMs) {
            continue;
          }
          queue.enqueue(e.agentId);
        }
      })
      .catch((err: unknown) => {
        console.error("[reconcile-runner] drift sweep async list failed", err);
      });
  }

  // ---------------------------------------------------------------------------
  // Process tick — dequeue and reconcile (sync-first)
  // ---------------------------------------------------------------------------

  function processTick(): void {
    if (disposed) return;

    // Concurrency cap: don't dequeue when async slots are exhausted
    const max = config.maxConcurrentReconciles;
    if (max > 0 && inFlightCount >= max) return;

    const agentId = queue.dequeue();
    if (agentId === undefined) return;

    const manifest = deps.manifests.get(agentId);
    const ctx = {
      registry: deps.registry,
      manifest: manifest ?? { name: "unknown", version: "0.0.0", model: { name: "unknown" } },
    };

    for (const controller of controllers) {
      if (disposed) break;

      const key = circuitKey(agentId, controller.name);

      // Check circuit breaker
      const failures = consecutiveFailures.get(key) ?? 0;
      if (failures >= config.maxConsecutiveFailures) {
        continue;
      }

      try {
        const result = controller.reconcile(agentId, ctx);

        if (isPromise(result)) {
          // Async controller — handle with timeout, fire-and-forget
          handleAsyncReconcile(agentId, controller, result);
        } else {
          // Sync controller — handle immediately in this tick
          handleResult(agentId, key, result);
        }
      } catch (err: unknown) {
        console.error(
          `[reconcile-runner] controller "${controller.name}" threw for agent "${agentId}"`,
          err,
        );
        handleError(agentId, key);
      }
    }

    lastReconciledAt.set(agentId, clock.now());
    queue.complete(agentId);
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  /** Enqueue all running agents — shared by startup sweep, on-demand sweep. */
  function enqueueRunningAgents(): void {
    const listed = deps.registry.list({ phase: "running" });

    if (!isPromise(listed)) {
      for (const e of listed) {
        queue.enqueue(e.agentId);
      }
      return;
    }

    // Async registry (rare — network-backed)
    void listed
      .then((entries) => {
        if (disposed) return;
        for (const e of entries) {
          queue.enqueue(e.agentId);
        }
      })
      .catch((err: unknown) => {
        console.error("[reconcile-runner] async list failed", err);
      });
  }

  function sweep(): void {
    if (disposed) return;
    enqueueRunningAgents();
  }

  function start(): void {
    if (disposed) return;

    // Startup sweep — enqueue all pre-existing running agents
    enqueueRunningAgents();

    processTickTimer = clock.setInterval(() => {
      processTick();
    }, 100);

    driftSweepTimer = clock.setInterval(() => {
      driftSweep();
    }, config.driftCheckIntervalMs);
  }

  function register(controller: ReconciliationController): void {
    controllers.push(controller);
  }

  function stats(): ReconcileRunnerStats {
    return {
      totalReconciled,
      totalRetried,
      totalCircuitBroken,
      queueSize: queue.size(),
      activeControllers: controllers.length,
      inFlightAsyncReconciles: inFlightCount,
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;

    unwatchRegistry();
    driftSweepTimer?.clear();
    processTickTimer?.clear();

    for (const timer of backoffTimers.values()) {
      timer.clear();
    }
    backoffTimers.clear();

    consecutiveFailures.clear();
    backoffState.clear();
    lastReconciledAt.clear();
    queue.clear();
  }

  return {
    start,
    register,
    sweep,
    stats,
    [Symbol.asyncDispose]: dispose,
  };
}
