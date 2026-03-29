/**
 * @koi/engine-compose — Middleware composition and guard factories (Layer 1)
 *
 * Pure middleware composition chains, iteration/loop/spawn guards,
 * extension composition, and visibility filtering.
 */

// composition
export type {
  CapabilityInjectionConfig,
  RecomposedChains,
  ResolvedMiddleware,
  TerminalHandlers,
} from "./compose.js";
export {
  collectCapabilities,
  composeModelChain,
  composeModelStreamChain,
  composeToolChain,
  formatCapabilityMessage,
  injectCapabilities,
  recomposeChains,
  resolveActiveMiddleware,
  runSessionHooks,
  runTurnHooks,
  sortMiddlewareByPhase,
} from "./compose.js";
// instrumentation
export type {
  ChannelIOSpan,
  DebugInstrumentation,
  DebugInstrumentationConfig,
  DebugInventory,
  DebugInventoryItem,
  DebugSpan,
  DebugTurnTrace,
  ForgeRefreshSpan,
  MiddlewareSource,
  ResolverSpan,
  ToolChildSpanRecord,
  VisibilityTier,
} from "./compose-instrumentation.js";
export { createDebugInstrumentation } from "./compose-instrumentation.js";
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
// guard types
export type {
  DepthToolRule,
  IterationLimits,
  LoopDetectionConfig,
  LoopDetectionKind,
  LoopWarningInfo,
  SpawnPolicy,
  SpawnWarningInfo,
} from "./guard-types.js";
export {
  DEFAULT_ITERATION_LIMITS,
  DEFAULT_LOOP_DETECTION,
  DEFAULT_SPAWN_POLICY,
  DEFAULT_SPAWN_TOOL_IDS,
} from "./guard-types.js";
// guards
export type { CreateSpawnGuardOptions } from "./guards.js";
export {
  createIterationGuard,
  createLoopDetector,
  createSpawnGuard,
  detectRepeatingPattern,
} from "./guards.js";
// visibility filter
export type { VisibilityFilterConfig } from "./visibility-filter.js";
export { createVisibilityFilter } from "./visibility-filter.js";
