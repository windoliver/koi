/**
 * Compaction policy — pure decision function.
 *
 * Given total token count and config, determines whether to noop,
 * microcompact, or fully compact.
 */

import type { CompactionDecision } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

/**
 * Determine the compaction action for the current turn.
 *
 * Zones:
 * - total < softTrigger              → "noop"
 * - softTrigger ≤ total < hardTrigger → "micro"
 * - total ≥ hardTrigger               → "full"
 *
 * When softTriggerFraction === hardTriggerFraction, the micro zone
 * is empty — transitions directly from noop to full.
 */
export function shouldCompact(
  totalTokens: number,
  contextWindowSize: number = COMPACTION_DEFAULTS.contextWindowSize,
  softTriggerFraction: number = COMPACTION_DEFAULTS.micro.triggerFraction,
  hardTriggerFraction: number = COMPACTION_DEFAULTS.full.triggerFraction,
): CompactionDecision {
  if (contextWindowSize <= 0) {
    return "noop";
  }

  const hardThreshold = contextWindowSize * hardTriggerFraction;
  const softThreshold = contextWindowSize * softTriggerFraction;

  if (totalTokens >= hardThreshold) {
    return "full";
  }
  if (totalTokens >= softThreshold) {
    return "micro";
  }
  return "noop";
}
