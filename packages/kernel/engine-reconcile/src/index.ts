/**
 * @koi/engine-reconcile — Reconciliation, supervision, and process management (Layer 1)
 *
 * Reconciliation controllers, process tree, health monitoring,
 * governance controllers, cascading termination, and shared infrastructure.
 */

// shared infra
export { computeBackoff } from "./backoff.js";
// cascading termination
export type { CascadingTermination } from "./cascading-termination.js";
export { createCascadingTermination } from "./cascading-termination.js";
export type { Clock, FakeClock, TimerHandle } from "./clock.js";
export { createFakeClock, createRealClock } from "./clock.js";
// concurrency
export type { ConcurrencyGuardConfig } from "./concurrency-guard.js";
export { createConcurrencyGuard, DEFAULT_CONCURRENCY_GUARD_CONFIG } from "./concurrency-guard.js";
export type { ConcurrencySemaphore } from "./concurrency-semaphore.js";
export { createConcurrencySemaphore } from "./concurrency-semaphore.js";
// eviction policies
export { lruPolicy, qosPolicy } from "./eviction-policies.js";
// governance
export type { GovernanceControllerBuilder } from "./governance-controller.js";
export { createGovernanceController } from "./governance-controller.js";
export { createGovernanceExtension } from "./governance-extension.js";
export { createGovernanceProvider } from "./governance-provider.js";
export type { AgentLookup } from "./governance-reconciler.js";
export { createGovernanceReconciler } from "./governance-reconciler.js";
// types
export type { GovernanceConfig, InMemoryRegistry } from "./governance-types.js";
export { createDefaultGovernanceConfig, DEFAULT_GOVERNANCE_CONFIG } from "./governance-types.js";
export type { InMemoryHealthMonitor } from "./health-monitor.js";
export { createHealthMonitor } from "./health-monitor.js";
export { createHealthReconciler } from "./health-reconciler.js";
export { isPromise } from "./is-promise.js";
export type { SharedProcessAccounter } from "./process-accounter.js";
export { createProcessAccounter } from "./process-accounter.js";
// process management
export type { ProcessTree } from "./process-tree.js";
export { createProcessTree } from "./process-tree.js";
// reconciliation
export type { ReconcileQueue } from "./reconcile-queue.js";
export { createReconcileQueue } from "./reconcile-queue.js";
export type { ReconcileRunner, ReconcileRunnerStats } from "./reconcile-runner.js";
export { createReconcileRunner } from "./reconcile-runner.js";
// registry
export { createInMemoryRegistry } from "./registry.js";
export type { RestartIntensityTracker } from "./restart-intensity.js";
export { createRestartIntensityTracker } from "./restart-intensity.js";
export type { RollingWindow } from "./rolling-window.js";
export { createRollingWindow } from "./rolling-window.js";
// controllers
export type { SpawnChildFn, SupervisionReconciler } from "./supervision-reconciler.js";
export { createSupervisionReconciler } from "./supervision-reconciler.js";
export { createTimeoutReconciler } from "./timeout-reconciler.js";
export { createToolReconciler } from "./tool-reconciler.js";
// transitions
export type { TransitionInput } from "./transitions.js";
export { applyTransition, validateTransition } from "./transitions.js";
