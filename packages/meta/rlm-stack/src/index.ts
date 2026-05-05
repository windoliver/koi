/**
 * @koi/rlm-stack — L3 composition wiring `@koi/middleware-rlm` with thresholds
 * coordinated against `@koi/context-manager`.
 *
 * No new processing algorithms — see `docs/L2/rlm-stack.md` and issue #1359.
 */

export { createRlmStack } from "./create-rlm-stack.js";
export { policyFor } from "./policy.js";
export type {
  RlmDisposition,
  RlmStack,
  RlmStackConfig,
  RlmStackThresholds,
  RlmStackTier,
} from "./types.js";
export {
  CHUNK_CHARS_BY_TIER,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  HARD_COMPACT_FRACTION,
  RLM_STACK_PRIORITY_FLOOR,
  SOFT_COMPACT_FRACTION,
} from "./types.js";
