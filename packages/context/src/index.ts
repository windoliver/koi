/**
 * @koi/context — Declarative context pre-loading for fast agent cold start.
 *
 * Provides a middleware that hydrates agent context from multiple sources
 * (text, file, memory, skill, tool schemas) at session start and prepends
 * it as a system message on every model call.
 *
 * L2 package — depends on @koi/core only.
 */

export { validateContextConfig } from "./config.js";
export { heuristicTokenEstimator } from "./estimator.js";
export type { ContextHydratorOptions } from "./hydrator.js";
export { createContextHydrator } from "./hydrator.js";
export type {
  ContextManifestConfig,
  ContextSource,
  FileSource,
  HydrationResult,
  MemorySource,
  SkillSource,
  SourceResult,
  TextSource,
  ToolSchemaSource,
} from "./types.js";
