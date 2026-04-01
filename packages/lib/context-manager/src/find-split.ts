/**
 * Find the optimal split point in a message array.
 *
 * Given valid split points (respecting pair boundaries), finds the
 * largest index where the tail (including rescued pinned messages
 * from the head) + summary fits within the context window.
 *
 * Verifies each candidate with `estimateMessages(fullTail)` on the
 * actual slice to support non-additive estimators (per-sequence overhead)
 * and to account for pinned messages that must be rescued from the head.
 */

import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { rescuePinnedGroups } from "./pair-boundaries.js";

/**
 * Find the optimal split index.
 *
 * Split at index `s` means: messages[0..s-1] are summarized,
 * messages[s..end] are preserved. Pinned messages (and their pair
 * partners) from the head are rescued and prepended to the tail.
 *
 * We want the largest `s` (most aggressive compaction) where
 * `rescuedPinned + tail + maxSummaryTokens <= contextWindowSize`.
 *
 * Scans from most aggressive to least aggressive, verifying each
 * candidate with the real estimator on the actual full tail.
 *
 * @returns The best split index, or -1 if no split fits the budget.
 */
export async function findOptimalSplit(
  messages: readonly InboundMessage[],
  validSplitPoints: readonly number[],
  contextWindowSize: number,
  maxSummaryTokens: number,
  estimator: TokenEstimator,
  model?: string,
): Promise<number> {
  const len = messages.length;
  if (len === 0 || validSplitPoints.length === 0) return -1;

  const budget = contextWindowSize - maxSummaryTokens;

  // Scan from largest split index (most aggressive) to smallest.
  // For each candidate, compute the full tail (rescued pinned + raw tail)
  // and verify it fits the budget.
  for (let i = validSplitPoints.length - 1; i >= 0; i--) {
    const splitIdx = validSplitPoints[i];
    if (splitIdx === undefined) continue;

    const rescued = rescuePinnedGroups(messages, splitIdx);
    const rawTail = messages.slice(splitIdx);
    const fullTail = rescued.length > 0 ? [...rescued, ...rawTail] : rawTail;
    const tailTokens = await estimator.estimateMessages(fullTail, model);

    if (tailTokens <= budget) {
      return splitIdx;
    }
  }

  return -1;
}
