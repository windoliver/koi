/**
 * @koi/context — Declarative context pre-loading for fast agent cold start.
 *
 * Provides a middleware that hydrates agent context from multiple sources
 * (text, file, memory, skill, tool schemas) at session start and prepends
 * it as a system message on every model call.
 *
 * L2 package — depends on @koi/core only.
 */

/** @deprecated Use HEURISTIC_ESTIMATOR from @koi/token-estimator instead. */
export {
  CHARS_PER_TOKEN,
  HEURISTIC_ESTIMATOR,
  HEURISTIC_ESTIMATOR as heuristicTokenEstimator,
} from "@koi/token-estimator";
export { validateContextConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createContextExtension } from "./extension.js";
export type { ContextHydratorMiddleware, ContextHydratorOptions } from "./hydrator.js";
export { createContextHydrator } from "./hydrator.js";
export { createCollectiveMemoryResolver } from "./sources/collective-memory.js";
export type {
  BootstrapManifestConfig,
  BootstrapSlotConfig,
  CollectiveMemoryContextSource,
  ContextManifestConfig,
  ContextSource,
  FileSource,
  HydrationResult,
  MemorySource,
  SkillSource,
  SourceBase,
  SourceResolver,
  SourceResult,
  TextSource,
  ToolSchemaSource,
} from "./types.js";
