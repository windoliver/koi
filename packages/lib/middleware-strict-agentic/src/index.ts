/**
 * @koi/middleware-strict-agentic — L2 middleware that blocks premature model
 * completion on filler/plan-only turns in agentic sessions.
 *
 * Install via agent manifest. Presence of this middleware IS the "agentic
 * mode" signal — no L0 or L1 changes are required.
 */

export type { ClassificationKind, ClassificationResult, TurnFacts } from "./classifier.js";
export { classifyTurn } from "./classifier.js";
export type {
  ResolvedStrictAgenticConfig,
  StrictAgenticConfig,
} from "./config.js";
export {
  DEFAULT_STRICT_AGENTIC_CONFIG,
  resolveStrictAgenticConfig,
  validateStrictAgenticConfig,
} from "./config.js";
export { DEFAULT_FEEDBACK } from "./feedback.js";
export type { StrictAgenticHandle } from "./middleware.js";
export { createStrictAgenticMiddleware } from "./middleware.js";
