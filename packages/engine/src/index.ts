/**
 * @koi/engine — Kernel runtime (Layer 1)
 *
 * Guards, lifecycle state machine, middleware composition, adapter dispatch,
 * registry, health monitoring, eviction policies, and disposal utilities.
 * Depends on @koi/core only.
 */

// agent entity
export { AgentEntity } from "./agent-entity.js";
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
// errors
export { KoiEngineError } from "./errors.js";
// eviction policies
export { lruPolicy, qosPolicy } from "./eviction-policies.js";
// guards
export {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
} from "./guards.js";
// health monitor
export type { InMemoryHealthMonitor } from "./health-monitor.js";
export { createHealthMonitor } from "./health-monitor.js";
// factory
export { createKoi } from "./koi.js";
// lifecycle
export type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
export { transition } from "./lifecycle.js";
// registry
export type { InMemoryRegistry } from "./registry.js";
export { createInMemoryRegistry } from "./registry.js";
// result pruner
export type { ResultPrunerConfig } from "./result-pruner.js";
export { createResultPruner } from "./result-pruner.js";
// transitions
export type { TransitionInput } from "./transitions.js";
export { applyTransition, validateTransition } from "./transitions.js";
// types
export type {
  CreateKoiOptions,
  IterationLimits,
  KoiRuntime,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./types.js";
