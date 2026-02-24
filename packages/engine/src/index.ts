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
export { AgentEntity } from "./agent-entity.js";
// swarm
export type { CascadingTermination } from "./cascading-termination.js";
export { createCascadingTermination } from "./cascading-termination.js";
export { createChildHandle } from "./child-handle.js";
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
// factory
export { createKoi } from "./koi.js";
// lifecycle
export type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
export { transition } from "./lifecycle.js";
export type { SharedProcessAccounter } from "./process-accounter.js";
export { createProcessAccounter } from "./process-accounter.js";
export type { ProcessTree } from "./process-tree.js";
export { createProcessTree } from "./process-tree.js";
// registry
export type { InMemoryRegistry } from "./registry.js";
export { createInMemoryRegistry } from "./registry.js";
// result pruner
export type { ResultPrunerConfig } from "./result-pruner.js";
export { createResultPruner } from "./result-pruner.js";
// spawn ledger
export { createInMemorySpawnLedger } from "./spawn-ledger.js";
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
  SpawnPolicy,
  SpawnWarningInfo,
} from "./types.js";
export { DEFAULT_SPAWN_TOOL_IDS } from "./types.js";
