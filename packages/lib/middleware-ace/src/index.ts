/**
 * @koi/middleware-ace — Adaptive Continuous Enhancement (L2).
 *
 * Current surface (#1715): shipped ACE middleware integration, pure stat
 * pipeline primitives, token-budgeted playbook injection, and promotion-gate
 * evaluation/commit/rollback orchestration.
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
export type { PromotionDecision, PromotionGateDeps } from "./promotion-gate.js";
export {
  applyProposalOperations,
  commitPromotion,
  evaluatePromotion,
  rollbackPromotion,
} from "./promotion-gate.js";
export { computeCurationScore, computeRecencyFactor } from "./scoring.js";
export type { CurateOptions, CurationScorer, StatsByIdentifier } from "./stats-aggregator.js";
export {
  aggregateTrajectoryStats,
  curateTrajectorySummary,
} from "./stats-aggregator.js";
