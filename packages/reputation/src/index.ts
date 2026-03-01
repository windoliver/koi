/**
 * @koi/reputation — In-memory reputation backend (Layer 2).
 *
 * Pluggable trust scoring using weighted feedback averages.
 * Depends on @koi/core (L0) only.
 */

export { createReputationProvider } from "./component-provider.js";
export { computeScore, DEFAULT_FEEDBACK_WEIGHTS } from "./compute-score.js";
export type { InMemoryReputationConfig } from "./in-memory-backend.js";
export { createInMemoryReputationBackend } from "./in-memory-backend.js";
