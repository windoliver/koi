/**
 * AI+Tool pair boundary detection.
 *
 * Groups assistant messages with their matching tool result messages
 * into "atomic groups" that must not be split. Returns valid split
 * point indices that respect these group boundaries.
 *
 * Unlike @koi/session-repair's mapCallIdPairs (which overwrites on
 * duplicate callIds for best-effort repair), this module matches each
 * tool result to its nearest preceding unmatched assistant with the
 * same callId. This protects ALL pairs in histories with duplicates.
 *
 * Pinned messages: splits ARE allowed past pinned messages. Callers
 * use `rescuePinnedGroups()` to extract pinned messages AND their
 * atomic pair partners from the head, preserving pair atomicity.
 */

import type { InboundMessage } from "@koi/core/message";

/**
 * Read a string-typed metadata field from a message, or undefined.
 */
function readCallId(msg: InboundMessage): string | undefined {
  return typeof msg.metadata?.callId === "string" ? msg.metadata.callId : undefined;
}

/**
 * A matched assistant+tool pair: the assistant index and its tool result index.
 */
export interface AssistantToolPair {
  readonly assistantIdx: number;
  readonly toolIdx: number;
}

/**
 * Match each tool result to its nearest preceding unmatched assistant
 * with the same callId. Returns matched pairs in tool-index order.
 *
 * This is the core matching algorithm shared by atomic group detection,
 * pair partner mapping, and content replacement identification.
 */
export function matchAssistantToolPairs(
  messages: readonly InboundMessage[],
): readonly AssistantToolPair[] {
  // Collect all assistant indices per callId, in order
  const assistantsByCallId = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined || msg.senderId !== "assistant") continue;
    const callId = readCallId(msg);
    if (callId === undefined) continue;
    const existing = assistantsByCallId.get(callId);
    if (existing !== undefined) {
      existing.push(i);
    } else {
      assistantsByCallId.set(callId, [i]);
    }
  }

  const consumed = new Set<number>();
  const pairs: AssistantToolPair[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined || msg.senderId !== "tool") continue;
    const callId = readCallId(msg);
    if (callId === undefined) continue;
    const candidates = assistantsByCallId.get(callId);
    if (candidates === undefined) continue;

    // Find nearest preceding unmatched assistant
    let matchIdx: number | undefined;
    for (let c = candidates.length - 1; c >= 0; c--) {
      const candidateIdx = candidates[c];
      if (candidateIdx !== undefined && candidateIdx < i && !consumed.has(candidateIdx)) {
        matchIdx = candidateIdx;
        break;
      }
    }

    if (matchIdx === undefined) continue;
    consumed.add(matchIdx);
    pairs.push({ assistantIdx: matchIdx, toolIdx: i });
  }

  return pairs;
}

/**
 * Map each message index to its atomic group (set of indices that
 * must stay together). Messages not in any pair map to a singleton
 * group containing only themselves.
 */
function buildAtomicGroups(
  messages: readonly InboundMessage[],
): ReadonlyMap<number, ReadonlySet<number>> {
  const pairs = matchAssistantToolPairs(messages);
  const groups = new Map<number, Set<number>>();

  for (const { assistantIdx, toolIdx } of pairs) {
    // Build the group: all indices from assistant through tool (inclusive)
    const group = new Set<number>();
    for (let j = assistantIdx; j <= toolIdx; j++) {
      group.add(j);
    }
    // Map every member to the same group
    for (const idx of group) {
      groups.set(idx, group);
    }
  }

  return groups;
}

/**
 * Build the set of "interior" indices from atomic groups.
 * Splitting at these indices would break a pair.
 */
function findAtomicGroupInteriors(messages: readonly InboundMessage[]): ReadonlySet<number> {
  const interiors = new Set<number>();
  const groups = buildAtomicGroups(messages);

  for (const [, group] of groups) {
    // The interior is everything except the first index in the group.
    // Splitting at the first index keeps the whole group in the tail.
    const minIdx = Math.min(...group);
    for (const idx of group) {
      if (idx !== minIdx) {
        interiors.add(idx);
      }
    }
  }

  return interiors;
}

/**
 * Find valid split point indices in a message array.
 *
 * A split at index `s` means: messages[0..s-1] go to the head (summarized
 * or truncated), messages[s..end] are preserved verbatim in the tail.
 *
 * Rules:
 * 1. Split index must be >= 1 (can't summarize zero messages).
 * 2. Split index must not be inside an atomic assistant+tool group.
 * 3. The tail (messages[s..end]) must contain at least `preserveRecent` messages.
 *
 * Pinned messages do NOT block splits. Callers must use `rescuePinnedGroups()`
 * to extract pinned messages and their pair partners from the head.
 *
 * Returns indices in ascending order.
 */
export function findValidSplitPoints(
  messages: readonly InboundMessage[],
  preserveRecent: number,
): readonly number[] {
  const len = messages.length;
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

/**
 * Build a map from message index to its direct pair partner index.
 * Only maps the two endpoints (assistant ↔ tool), not intervening messages.
 */
function buildPairPartners(messages: readonly InboundMessage[]): ReadonlyMap<number, number> {
  const partners = new Map<number, number>();
  for (const { assistantIdx, toolIdx } of matchAssistantToolPairs(messages)) {
    partners.set(assistantIdx, toolIdx);
    partners.set(toolIdx, assistantIdx);
  }
  return partners;
}

/**
 * Rescue pinned messages AND their direct pair partners from a head region.
 *
 * When compaction splits messages into head (to be dropped/summarized) and
 * tail (to be preserved), pinned messages in the head must be rescued.
 * To maintain pair atomicity, if a pinned message is one half of an
 * assistant+tool pair, its direct partner is also rescued (but only if
 * the partner is in the head — tail-side partners are already preserved).
 *
 * Only the two pair endpoints (assistant, tool) are rescued — intervening
 * messages in the split-blocking range are NOT rescued.
 *
 * @param allMessages — The full message array (needed for pair detection).
 * @param splitIdx — The split index (head = allMessages[0..splitIdx-1]).
 * @returns Rescued messages in their original order.
 */
export function rescuePinnedGroups(
  allMessages: readonly InboundMessage[],
  splitIdx: number,
): readonly InboundMessage[] {
  // Fast path: no pinned messages in head
  let hasPinned = false;
  for (let i = 0; i < splitIdx; i++) {
    if (allMessages[i]?.pinned === true) {
      hasPinned = true;
      break;
    }
  }
  if (!hasPinned) return [];

  const partners = buildPairPartners(allMessages);
  const rescuedIndices = new Set<number>();

  for (let i = 0; i < splitIdx; i++) {
    const msg = allMessages[i];
    if (msg === undefined || msg.pinned !== true) continue;

    // Rescue the pinned message itself
    rescuedIndices.add(i);

    // Rescue its direct pair partner if it's also in the head
    const partnerIdx = partners.get(i);
    if (partnerIdx !== undefined && partnerIdx < splitIdx) {
      rescuedIndices.add(partnerIdx);
    }
  }

  // Return in original order
  return [...rescuedIndices]
    .sort((a, b) => a - b)
    .map((i) => allMessages[i])
    .filter((m): m is InboundMessage => m !== undefined);
}
