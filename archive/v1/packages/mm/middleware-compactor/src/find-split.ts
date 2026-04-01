/**
 * Find the optimal split point in a message array using prefix sums.
 *
 * Given valid split points (respecting pair boundaries), finds the
 * largest index where the tail + summary fits within the context window.
 */

import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";

/**
 * Find the optimal split index.
 *
 * Split at index `s` means: messages[0..s-1] are summarized,
 * messages[s..end] are preserved. We want the largest `s` (most
 * aggressive compaction) where `tailTokens + maxSummaryTokens <= contextWindowSize`.
 *
 * Uses a prefix sum array for O(N) computation.
 *
 * @returns The best split index, or -1 if no split fits the budget.
 */
export async function findOptimalSplit(
  messages: readonly InboundMessage[],
  validSplitPoints: readonly number[],
  contextWindowSize: number,
  maxSummaryTokens: number,
  estimator: TokenEstimator,
): Promise<number> {
  const len = messages.length;
  if (len === 0 || validSplitPoints.length === 0) return -1;

  // Build per-message token counts (await supports async estimators)
  const tokenCounts: number[] = [];
  for (const msg of messages) {
    let count = 0;
    if (msg !== undefined) {
      for (const block of msg.content) {
        if (block.kind === "text") {
          count += await estimator.estimateText(block.text);
        }
      }
    }
    tokenCounts.push(count);
  }

  // Build prefix sums: prefix[i] = sum of tokens for messages[0..i-1]
  const prefix: number[] = [0];
  let running = 0;
  for (const tc of tokenCounts) {
    running += tc;
    prefix.push(running);
  }

  const totalTokens = prefix[len] ?? 0;
  const budget = contextWindowSize - maxSummaryTokens;

  // Scan from largest split index (most aggressive) to smallest
  for (let i = validSplitPoints.length - 1; i >= 0; i--) {
    const splitIdx = validSplitPoints[i];
    if (splitIdx === undefined) continue;
    const tailTokens = totalTokens - (prefix[splitIdx] ?? 0);
    if (tailTokens <= budget) {
      return splitIdx;
    }
  }

  return -1;
}
