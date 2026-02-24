/**
 * @koi/middleware-ace — Adaptive Continuous Enhancement (Layer 2)
 *
 * Records action/outcome trajectories per session, curates high-value patterns,
 * consolidates learnings into persistent playbooks, and auto-injects relevant
 * strategies into future sessions.
 * Depends on @koi/core only.
 */

export { createAceMiddleware } from "./ace.js";
export type { AceConfig } from "./config.js";
export { validateAceConfig } from "./config.js";
export type { DefaultConsolidatorOptions } from "./consolidator.js";
export { createDefaultConsolidator } from "./consolidator.js";
export { type CurateOptions, curateTrajectorySummary } from "./curator.js";
export { estimateTokens, selectPlaybooks } from "./injector.js";
export { computeCurationScore, computeRecencyFactor } from "./scoring.js";
export type { PlaybookStore, TrajectoryStore } from "./stores.js";
export {
  createInMemoryPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";
export type { TrajectoryBuffer } from "./trajectory-buffer.js";
export { createTrajectoryBuffer } from "./trajectory-buffer.js";
export type {
  AceFeedback,
  AggregatedStats,
  CurationCandidate,
  Playbook,
  PlaybookSource,
  TrajectoryEntry,
} from "./types.js";
