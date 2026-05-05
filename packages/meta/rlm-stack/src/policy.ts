/**
 * Pure classifier — given an estimated token count and the resolved
 * thresholds, return the disposition the stack would apply.
 *
 * Boundaries:
 *   tokens <  softCompact*window           → passthrough
 *   softCompact*window <= tokens < maxIn   → compact (handled by context-manager)
 *   tokens >= maxInputTokens               → virtualize (RLM segments)
 */

import type { RlmDisposition, RlmStackThresholds } from "./types.js";
import { SOFT_COMPACT_FRACTION } from "./types.js";

export function policyFor(estimatedTokens: number, thresholds: RlmStackThresholds): RlmDisposition {
  if (estimatedTokens >= thresholds.maxInputTokens) return "virtualize";
  const softBoundary = thresholds.contextWindowTokens * SOFT_COMPACT_FRACTION;
  if (estimatedTokens >= softBoundary) return "compact";
  return "passthrough";
}
