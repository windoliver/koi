/**
 * @koi/middleware-ace — Adaptive Continuous Enhancement (L2).
 *
 * Phase 1 surface (#1715): pure stat-pipeline primitives + token-budgeted
 * playbook injection. Middleware integration, LLM reflector/curator, and
 * promotion-gate wiring land in subsequent steps.
 */

export type { AceConfig } from "./ace-middleware.js";
export { createAceMiddleware } from "./ace-middleware.js";
export type { ConsolidateFn, DefaultConsolidatorOptions } from "./consolidator.js";
export { createDefaultConsolidator } from "./consolidator.js";
export {
  createInMemoryPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./in-memory-store.js";
export type { SelectOptions } from "./injector.js";
export { formatActivePlaybooksMessage, selectPlaybooks } from "./injector.js";
export { computeCurationScore, computeRecencyFactor } from "./scoring.js";
export type { CurateOptions, CurationScorer, StatsByIdentifier } from "./stats-aggregator.js";
export {
  aggregateTrajectoryStats,
  curateTrajectorySummary,
} from "./stats-aggregator.js";
