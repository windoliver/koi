/**
 * AI+Tool pair boundary detection.
 *
 * Groups assistant messages with their matching tool result messages
 * into "atomic groups" that must not be split. Returns valid split
 * point indices that respect these group boundaries.
 */

import type { InboundMessage } from "@koi/core/message";
import { mapCallIdPairs } from "@koi/session-repair";

/**
 * Build a set of index ranges that form atomic groups (assistant + tool results).
 *
 * Returns a Set of indices that are "interior" to a group — splitting
 * at these indices would break a pair.
 */
function findAtomicGroupInteriors(messages: readonly InboundMessage[]): ReadonlySet<number> {
  const interiors = new Set<number>();
  const { assistantByCallId } = mapCallIdPairs(messages);

  // For each tool result with a callId, find its matching assistant and mark the range interior
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "tool") continue;
    const callId = typeof msg.metadata?.callId === "string" ? msg.metadata.callId : undefined;
    if (callId === undefined) continue;
    const assistantIdx = assistantByCallId.get(callId);
    if (assistantIdx === undefined) continue;

    // Mark all indices strictly between assistantIdx and i (inclusive of both endpoints
    // means splitting AT assistantIdx+1 through i would break the pair).
    // A split at index `s` means [0..s-1] is head, [s..end] is tail.
    // To keep the pair together, we cannot split at any index from assistantIdx+1 through i.
    for (let j = assistantIdx + 1; j <= i; j++) {
      interiors.add(j);
    }
  }

  return interiors;
}

/**
 * Find the first pinned message index.
 *
 * All split points must be <= this index so that pinned messages
 * remain in the preserved tail and are never summarized away.
 * Returns `len` if no messages are pinned (no additional constraint).
 */
function findFirstPinnedIndex(messages: readonly InboundMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg !== undefined && msg.pinned === true) return i;
  }
  return messages.length;
}

/**
 * Find valid split point indices in a message array.
 *
 * A split at index `s` means: messages[0..s-1] go to the summary,
 * messages[s..end] are preserved verbatim.
 *
 * Rules:
 * 1. Split index must be >= 1 (can't summarize zero messages).
 * 2. Split index must not be inside an atomic assistant+tool group.
 * 3. The tail (messages[s..end]) must contain at least `preserveRecent` messages.
 * 4. Split index must not place a pinned message in the head (summarized portion).
 *
 * Returns indices in ascending order.
 */
export function findValidSplitPoints(
  messages: readonly InboundMessage[],
  preserveRecent: number,
): readonly number[] {
  const len = messages.length;
  // Maximum split index: must leave at least preserveRecent messages in tail
  const maxSplitIndex = len - preserveRecent;
  if (maxSplitIndex < 1) return [];

  // Pinned messages must stay in the tail — cap split index before first pinned
  const pinnedCap = findFirstPinnedIndex(messages);

  const interiors = findAtomicGroupInteriors(messages);
  const validPoints: number[] = [];
  const effectiveMax = Math.min(maxSplitIndex, pinnedCap);

  for (let s = 1; s <= effectiveMax; s++) {
    if (!interiors.has(s)) {
      validPoints.push(s);
    }
  }

  return validPoints;
}
