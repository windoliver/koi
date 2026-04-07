/**
 * Microcompact — truncation-based compaction strategy.
 *
 * Drops the oldest messages (outside preserveRecent window) until
 * token count is at or below the target fraction. Respects pair
 * boundaries via findValidSplitPoints.
 *
 * Pinned messages in the dropped region are rescued along with their
 * atomic pair partners (assistant+tool groups) to maintain pair atomicity.
 *
 * Verifies tail token counts with `estimateMessages(tail)` on the
 * actual slice to support non-additive estimators (per-sequence overhead).
 *
 * Strategies returned:
 * - "noop": no truncation needed or possible
 * - "micro-truncate": truncated to within target budget
 * - "micro-truncate-partial": truncated as aggressively as possible
 *   but could not reach target budget (callers should promote to full compact)
 *
 * ## Prompt cache interaction (#1554)
 *
 * Prompt caching providers (Anthropic, OpenAI) cache the KV state from
 * the request prefix. Dropping messages shifts all subsequent token
 * positions, invalidating the cached prefix even if the system prompt
 * and tool definitions are unchanged.
 *
 * A future optimization could prefer dropping messages that precede the
 * last provider-reported cache breakpoint, preserving the cached prefix.
 * This requires cache-boundary metadata from the model adapter (e.g.,
 * `cacheReadTokens` from the response), which is not yet propagated to
 * the context manager.
 *
 * Additionally, `structured-output-guard` mutates the system prompt
 * during `wrapModelCall`, which is another source of prefix instability
 * independent of compaction — tracked separately.
 */

import type { TokenEstimator } from "@koi/core";
import type { CompactionResult } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { maybeAwait } from "./async-util.js";
import { findValidSplitPoints, rescuePinnedGroups } from "./pair-boundaries.js";

/**
 * Build a noop result (no compaction needed or possible).
 */
function noopResult(messages: readonly InboundMessage[], tokenCount: number): CompactionResult {
  return {
    messages,
    originalTokens: tokenCount,
    compactedTokens: tokenCount,
    strategy: "noop",
  };
}

/**
 * Build the compacted tail by rescuing pinned messages (and their pair
 * partners) from the head and prepending them to the raw tail.
 */
function buildTailWithRescued(
  allMessages: readonly InboundMessage[],
  splitIdx: number,
): readonly InboundMessage[] {
  const rescued = rescuePinnedGroups(allMessages, splitIdx);
  const rawTail = allMessages.slice(splitIdx);
  if (rescued.length === 0) return rawTail;
  return [...rescued, ...rawTail];
}

/**
 * Perform microcompact by truncating the oldest messages to reach
 * the target token count.
 *
 * Finds valid split points respecting pair boundaries, then picks
 * the smallest split index where the tail's token count (including
 * rescued pinned messages and their pair partners) is at or below
 * `targetTokens`.
 *
 * Each candidate tail is verified with `estimateMessages(tail)` on
 * the actual slice to support non-additive estimators.
 *
 * Returns a CompactionResult with strategy:
 * - "noop" — no truncation needed or no valid split points
 * - "micro-truncate" — truncated to within target budget
 * - "micro-truncate-partial" — best-effort truncation, still over budget
 */
export async function microcompact(
  messages: readonly InboundMessage[],
  targetTokens: number,
  preserveRecent: number,
  estimator: TokenEstimator,
  model?: string,
): Promise<CompactionResult> {
  const originalTokens = await maybeAwait(estimator.estimateMessages(messages, model));

  // Already below target — no truncation needed
  if (originalTokens <= targetTokens) {
    return noopResult(messages, originalTokens);
  }

  const validSplitPoints = findValidSplitPoints(messages, preserveRecent);

  // No valid split points — can't truncate
  if (validSplitPoints.length === 0) {
    return noopResult(messages, originalTokens);
  }

  // Find the smallest split point where tail tokens ≤ target.
  // Rescued pinned messages (and their pair partners) are included in the tail.
  for (const splitIdx of validSplitPoints) {
    const tail = buildTailWithRescued(messages, splitIdx);
    const tailTokens = await maybeAwait(estimator.estimateMessages(tail, model));
    if (tailTokens <= targetTokens) {
      return {
        messages: tail,
        originalTokens,
        compactedTokens: tailTokens,
        strategy: "micro-truncate",
      };
    }
  }

  // No split point reaches target — use the most aggressive valid split.
  // Return "micro-truncate-partial" so callers know the target was NOT met.
  const lastSplit = validSplitPoints[validSplitPoints.length - 1];
  if (lastSplit !== undefined) {
    const tail = buildTailWithRescued(messages, lastSplit);
    const tailTokens = await maybeAwait(estimator.estimateMessages(tail, model));
    return {
      messages: tail,
      originalTokens,
      compactedTokens: tailTokens,
      strategy: "micro-truncate-partial",
    };
  }

  return noopResult(messages, originalTokens);
}
