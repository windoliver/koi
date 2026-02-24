/**
 * AI+Tool pair boundary detection.
 *
 * Groups assistant messages with their matching tool result messages
 * into "atomic groups" that must not be split. Returns valid split
 * point indices that respect these group boundaries.
 */

import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";

/** Safely reads a string value from metadata. */
function readStringMeta(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Build a set of index ranges that form atomic groups (assistant + tool results).
 *
 * Returns a Set of indices that are "interior" to a group — splitting
 * at these indices would break a pair.
 */
function findAtomicGroupInteriors(messages: readonly InboundMessage[]): ReadonlySet<number> {
  const interiors = new Set<number>();

  // Map callId → assistant message index
  const assistantByCallId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "assistant") continue;
    const callId = readStringMeta(msg.metadata, "callId");
    if (callId !== undefined) {
      assistantByCallId.set(callId, i);
    }
  }

  // For each tool result, find its matching assistant and mark the range interior
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "tool") continue;
    const callId = readStringMeta(msg.metadata, "callId");
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
 * Find valid split point indices in a message array.
 *
 * A split at index `s` means: messages[0..s-1] go to the summary,
 * messages[s..end] are preserved verbatim.
 *
 * Rules:
 * 1. Split index must be >= 1 (can't summarize zero messages).
 * 2. Split index must not be inside an atomic assistant+tool group.
 * 3. The tail (messages[s..end]) must contain at least `preserveRecent` messages.
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

  const interiors = findAtomicGroupInteriors(messages);
  const validPoints: number[] = [];

  for (let s = 1; s <= maxSplitIndex; s++) {
    if (!interiors.has(s)) {
      validPoints.push(s);
    }
  }

  return validPoints;
}
