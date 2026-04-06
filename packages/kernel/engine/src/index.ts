/**
 * @koi/engine — Kernel runtime (Layer 1)
 *
 * Guards, lifecycle state machine, middleware composition, adapter dispatch,
 * registry, health monitoring, eviction policies, and disposal utilities.
 * Depends on @koi/core only.
 *
 * Re-exports everything from @koi/engine-compose and @koi/engine-reconcile
 * for backward compatibility — downstream consumers import from @koi/engine.
 */

export type {
  CapabilityInjectionConfig,
  ComposedExtensions,
  CreateSpawnGuardOptions,
  DebugInstrumentation,
  DebugInstrumentationConfig,
  DebugInventory,
  DebugInventoryItem,
  DebugSpan,
  DebugTurnTrace,
  DefaultGuardExtensionConfig,
  DepthToolRule,
  IterationLimits,
  LoopDetectionConfig,
  LoopDetectionKind,
  LoopWarningInfo,
  MiddlewareSource,
  RecomposedChains,
  SpawnPolicy,
  SpawnWarningInfo,
  TerminalHandlers,
  TransitionValidator,
  VisibilityFilterConfig,
} from "@koi/engine-compose";
// ── Re-exports from @koi/engine-compose ────────────────────────────────────
export {
  // composition
  collectCapabilities,
  // extension composer
  composeExtensions,
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  // instrumentation
  createDebugInstrumentation,
  createDefaultGuardExtension,
  // guards
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
  // visibility filter
  createVisibilityFilter,
  // guard type defaults
  DEFAULT_ITERATION_LIMITS,
  DEFAULT_LOOP_DETECTION,
  DEFAULT_SPAWN_POLICY,
  DEFAULT_SPAWN_TOOL_IDS,
  detectRepeatingPattern,
  injectCapabilities,
  isSignificantTransition,
  recomposeChains,
  resolveActiveMiddleware,
  runSessionHooks,
  runTurnHooks,
  sortMiddlewareByPhase,
} from "@koi/engine-compose";
export type {
  AgentLookup,
  CascadingTermination,
  Clock,
  ConcurrencyGuardConfig,
  ConcurrencySemaphore,
  FakeClock,
  GovernanceConfig,
  GovernanceControllerBuilder,
  InMemoryHealthMonitor,
  InMemoryRegistry,
  ProcessTree,
  ReconcileQueue,
  ReconcileRunner,
  ReconcileRunnerStats,
  RestartIntensityTracker,
  RollingWindow,
  SharedProcessAccounter,
  SpawnChildFn,
  SupervisionReconciler,
  TimerHandle,
  TransitionInput,
} from "@koi/engine-reconcile";
// ── Re-exports from @koi/engine-reconcile ──────────────────────────────────
export {
  // transitions
  applyTransition,
  // shared infra
  computeBackoff,
  // cascading termination
  createCascadingTermination,
  // concurrency
  createConcurrencyGuard,
  createConcurrencySemaphore,
  // governance type defaults
  createDefaultGovernanceConfig,
  createFakeClock,
  // governance
  createGovernanceController,
  createGovernanceExtension,
  createGovernanceProvider,
  createGovernanceReconciler,
  createHealthMonitor,
  createHealthReconciler,
  // registry
  createInMemoryRegistry,
  createProcessAccounter,
  // process management
  createProcessTree,
  createRealClock,
  // reconciliation
  createReconcileQueue,
  createReconcileRunner,
  createRestartIntensityTracker,
  createRollingWindow,
  // controllers
  createSupervisionReconciler,
  createTimeoutReconciler,
  createToolReconciler,
  DEFAULT_CONCURRENCY_GUARD_CONFIG,
  DEFAULT_GOVERNANCE_CONFIG,
  isPromise,
  // eviction policies
  lruPolicy,
  qosPolicy,
  validateTransition,
} from "@koi/engine-reconcile";

// ── Own exports (engine-specific) ──────────────────────────────────────────

// SpawnInheritanceConfig moved to @koi/core (L0) — re-export for backwards compatibility
export type { SpawnInheritanceConfig } from "@koi/core";
// errors
export { KoiRuntimeError } from "@koi/errors";
// agent entity
export type { AssemblyConflict, AssemblyResult } from "./agent-entity.js";
export { AgentEntity } from "./agent-entity.js";
// agent env provider
export type { AgentEnvProviderConfig } from "./agent-env-provider.js";
export { createAgentEnvProvider, mergeEnv } from "./agent-env-provider.js";
// brick requires extension
export { createBrickRequiresExtension } from "./brick-requires-extension.js";
// child handle
export { createChildHandle } from "./child-handle.js";
// compose bridge (lifecycle-aware terminals)
export { createComposedCallHandlers, createTerminalHandlers } from "./compose-bridge.js";
// agent spawn adapter
export type { CreateAgentSpawnFnOptions } from "./create-agent-spawn-fn.js";
export { createAgentSpawnFn } from "./create-agent-spawn-fn.js";
// hook spawn adapter
export type { CreateHookSpawnFnOptions, HookAgentMarker } from "./create-hook-spawn-fn.js";
export { createHookSpawnFn } from "./create-hook-spawn-fn.js";
// spawn tool provider
export type { SpawnToolProviderConfig } from "./create-spawn-tool-provider.js";
export { createSpawnToolProvider } from "./create-spawn-tool-provider.js";
// deduped tools accessor
export { createDedupedToolsAccessor } from "./deduped-tools-accessor.js";
// delivery policy
export type { ApplyDeliveryPolicyConfig, DeliveryHandle } from "./delivery-policy.js";
export { applyDeliveryPolicy, resolveDeliveryPolicy } from "./delivery-policy.js";
// dispose
export { disposeAll } from "./dispose.js";
// group operations
export { listByGroup, signalGroup } from "./group-operations.js";
// inbox queue
export { createInboxQueue } from "./inbox-queue.js";
// inherited channel proxy
export { createInheritedChannel } from "./inherited-channel.js";
// inherited component provider
export type { InheritedComponentProviderConfig } from "./inherited-component-provider.js";
export { createInheritedComponentProvider } from "./inherited-component-provider.js";
// factory
export { createKoi } from "./koi.js";
// lifecycle
export type { AgentLifecycle, LifecycleEvent } from "./lifecycle.js";
export { transition } from "./lifecycle.js";
// output collectors
export type { OutputCollector } from "./output-collector.js";
export { createTextCollector, createVerdictCollector } from "./output-collector.js";
// result pruner
export type { ResultPrunerConfig } from "./result-pruner.js";
export { createResultPruner } from "./result-pruner.js";
// shared spawn lifecycle
export type { RunSpawnedAgentOptions } from "./run-spawned-agent.js";
export { createSystemPromptMiddleware, runSpawnedAgent } from "./run-spawned-agent.js";
// spawn child
export { spawnChildAgent } from "./spawn-child.js";
// spawn ledger
export { createInMemorySpawnLedger } from "./spawn-ledger.js";
// types
export type {
  CreateKoiOptions,
  ForgeRuntime,
  KoiRuntime,
  SpawnChildOptions,
  SpawnChildResult,
} from "./types.js";
