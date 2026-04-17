/**
 * Fast-path check for whether a message array needs repair.
 *
 * Single O(n) pass with lazy hashing. Returns true if any repair
 * phase would produce changes, false otherwise.
 */

import type { InboundMessage } from "@koi/core/message";
import { computeContentHash } from "@koi/hash";
import { isMergeable } from "./internal.js";
import { mapCallIdPairs } from "./map-call-id-pairs.js";

/**
 * Fast-path check: does this message array need any repairs?
 *
 * Checks all 3 phases:
 * 1. Orphan detection via mapCallIdPairs (works on any length)
 * 2. Adjacent dedup detection (lazy hashing, requires 2+ messages)
 * 3. Merge eligibility detection (requires 2+ messages)
 */
export function needsRepair(messages: readonly InboundMessage[]): boolean {
  if (messages.length === 0) return false;

  // Phase 1: check for orphans/dangling (a single orphan tool is a valid repair case)
  const pairs = mapCallIdPairs(messages);
  if (pairs.orphanToolIndices.length > 0 || pairs.danglingToolUseIndices.length > 0) {
    return true;
  }

  // Phases 2+3 require at least 2 messages
  if (messages.length < 2) return false;

  // Phase 2+3: check adjacent pairs for merge or dedup eligibility
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev === undefined || curr === undefined) continue;

    if (prev.senderId === curr.senderId) {
      // O(1) merge check first — avoids unnecessary hashing
      if (isMergeable(prev) && isMergeable(curr)) return true;

      // Dedup check: hash comparison (only for non-mergeable same-sender pairs)
      const prevHash = computeContentHash(prev.content);
      const currHash = computeContentHash(curr.content);
      if (prevHash === currHash) return true;
    }

    // Two consecutive non-pinned user messages with different content →
    // interrupt repair needed (identical ones already caught by dedup above).
    if (
      prev.senderId === "user" &&
      curr.senderId === "user" &&
      prev.pinned !== true &&
      curr.pinned !== true
    ) {
      const prevHash = computeContentHash(prev.content);
      const currHash = computeContentHash(curr.content);
      if (prevHash !== currHash) return true;
    }
  }

  return false;
}
