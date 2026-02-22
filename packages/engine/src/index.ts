/**
 * @koi/engine — Kernel runtime (Layer 1)
 *
 * Guards, lifecycle state machine, middleware composition, and adapter dispatch.
 * Depends only on @koi/core (Layer 0).
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
// errors
export { KoiEngineError } from "./errors.js";
// guards
export {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
} from "./guards.js";
// factory
export { createKoi } from "./koi.js";
// lifecycle
export type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
export { transition } from "./lifecycle.js";
// result pruner
export type { ResultPrunerConfig } from "./result-pruner.js";
export { createResultPruner } from "./result-pruner.js";
// types
export type {
  CreateKoiOptions,
  IterationLimits,
  KoiRuntime,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./types.js";
