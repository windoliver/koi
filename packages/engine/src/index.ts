/**
 * @koi/engine — Kernel runtime (Layer 1)
 *
 * Guards, lifecycle state machine, middleware composition, adapter dispatch,
 * registry, health monitoring, eviction policies, and disposal utilities.
 * Depends on @koi/core only.
 */

// errors
export { KoiRuntimeError } from "@koi/errors";
// agent entity
export type { AssemblyConflict, AssemblyResult } from "./agent-entity.js";
export { AgentEntity } from "./agent-entity.js";
export { computeBackoff } from "./backoff.js";
// swarm
export type { CascadingTermination } from "./cascading-termination.js";
export { createCascadingTermination } from "./cascading-termination.js";
export { createChildHandle } from "./child-handle.js";
export type { Clock, FakeClock, TimerHandle } from "./clock.js";
export { createFakeClock, createRealClock } from "./clock.js";
export type { TerminalHandlers } from "./compose.js";
// composition
export {
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  createComposedCallHandlers,
  createTerminalHandlers,
  runSessionHooks,
  runTurnHooks,
} from "./compose.js";
// dispose
export { disposeAll } from "./dispose.js";
// eviction policies
export { lruPolicy, qosPolicy } from "./eviction-policies.js";
// extension composer
export type {
  ComposedExtensions,
  DefaultGuardExtensionConfig,
  TransitionValidator,
} from "./extension-composer.js";
export {
  composeExtensions,
  createDefaultGuardExtension,
  isSignificantTransition,
} from "./extension-composer.js";
// guards
export type { CreateSpawnGuardOptions } from "./guards.js";
export {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
  detectRepeatingPattern,
} from "./guards.js";
// health monitor
export type { InMemoryHealthMonitor } from "./health-monitor.js";
export { createHealthMonitor } from "./health-monitor.js";
export { createHealthReconciler } from "./health-reconciler.js";
// inherited component provider
export type { InheritedComponentProviderConfig } from "./inherited-component-provider.js";
export { createInheritedComponentProvider } from "./inherited-component-provider.js";
export { isPromise } from "./is-promise.js";
// factory
export { createKoi } from "./koi.js";
// lifecycle
export type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
export { transition } from "./lifecycle.js";
export type { SharedProcessAccounter } from "./process-accounter.js";
export { createProcessAccounter } from "./process-accounter.js";
export type { ProcessTree } from "./process-tree.js";
export { createProcessTree } from "./process-tree.js";
export type { ReconcileQueue } from "./reconcile-queue.js";
export { createReconcileQueue } from "./reconcile-queue.js";
// reconciliation
export type { ReconcileRunner, ReconcileRunnerStats } from "./reconcile-runner.js";
export { createReconcileRunner } from "./reconcile-runner.js";
// registry
export type { InMemoryRegistry } from "./registry.js";
export { createInMemoryRegistry } from "./registry.js";
// restart intensity
export type { RestartIntensityTracker } from "./restart-intensity.js";
export { createRestartIntensityTracker } from "./restart-intensity.js";
// result pruner
export type { ResultPrunerConfig } from "./result-pruner.js";
export { createResultPruner } from "./result-pruner.js";
// spawn child
export { spawnChildAgent } from "./spawn-child.js";
// spawn ledger
export { createInMemorySpawnLedger } from "./spawn-ledger.js";
// supervision
export type { SpawnChildFn, SupervisionReconciler } from "./supervision-reconciler.js";
export { createSupervisionReconciler } from "./supervision-reconciler.js";
export { createTimeoutReconciler } from "./timeout-reconciler.js";
export { createToolReconciler } from "./tool-reconciler.js";
// transitions
export type { TransitionInput } from "./transitions.js";
export { applyTransition, validateTransition } from "./transitions.js";
// types
export type {
  CreateKoiOptions,
  ForgeRuntime,
  IterationLimits,
  KoiRuntime,
  LoopDetectionConfig,
  LoopDetectionKind,
  LoopWarningInfo,
  SpawnChildOptions,
  SpawnPolicy,
  SpawnResult,
  SpawnWarningInfo,
} from "./types.js";
export { DEFAULT_SPAWN_TOOL_IDS } from "./types.js";
