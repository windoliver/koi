/**
 * @koi/competitive-broadcast — Competitive selection + broadcast (Layer 2)
 *
 * Implements GWT-inspired agent coordination: multiple agents compete
 * to solve a task, the best result is selected, and the winner is
 * broadcast to all agents for system-wide coherence.
 *
 * Depends on @koi/core and @koi/errors only.
 */

// Broadcast sink factories
export {
  type BroadcastRecipient,
  createEventBroadcastSink,
  createInMemoryBroadcastSink,
  type EventComponentLike,
} from "./broadcast.js";
// Config
export type { CycleConfig } from "./config.js";
export { DEFAULT_CYCLE_CONFIG, validateCycleConfig } from "./config.js";
// Core function
export { runCycle } from "./cycle.js";
// Selection strategy factories
export {
  type ConsensusOptions,
  createConsensusSelector,
  createFirstWinsSelector,
  createScoredSelector,
} from "./selection.js";
// Types
export type {
  BroadcastReport,
  BroadcastResult,
  BroadcastSink,
  CycleEvent,
  Proposal,
  ProposalId,
  SelectionStrategy,
  Vote,
} from "./types.js";
// Branded constructors + type guards
export { isProposal, proposalId } from "./types.js";
