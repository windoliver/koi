/**
 * Call-ID pair mapping for assistant+tool message pairing.
 *
 * Builds a map of callId -> assistant index and identifies orphans
 * (tool results with no matching assistant) and dangling tool_use
 * (assistant messages with no matching tool result).
 */

import type { InboundMessage } from "@koi/core/message";
import { readStringMeta } from "./internal.js";
import type { CallIdPairMap } from "./types.js";

/**
 * Map callId pairs in a message array.
 *
 * Scans all messages to build:
 * - assistantByCallId: callId -> assistant message index
 * - orphanToolIndices: tool messages whose callId has no matching assistant
 * - danglingToolUseIndices: assistant messages whose callId has no matching tool result
 *
 * **Assumption:** callIds are unique across assistant messages. If a corrupted
 * history contains duplicate callIds, only the last assistant message for each
 * callId is tracked — earlier duplicates are silently overwritten. This is
 * acceptable for best-effort repair on malformed histories.
 */
export function mapCallIdPairs(messages: readonly InboundMessage[]): CallIdPairMap {
  const assistantByCallId = new Map<string, number>();
  const matchedCallIds = new Set<string>();

  // Pass 1: collect all assistant callIds
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "assistant") continue;
    const callId = readStringMeta(msg.metadata, "callId");
    if (callId !== undefined) {
      assistantByCallId.set(callId, i);
    }
  }

  // Pass 2: find orphan tools and track which callIds are matched
  const orphanToolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "tool") continue;
    const callId = readStringMeta(msg.metadata, "callId");
    if (callId === undefined) continue;
    if (assistantByCallId.has(callId)) {
      matchedCallIds.add(callId);
    } else {
      orphanToolIndices.push(i);
    }
  }

  // Pass 3: find dangling assistant tool_use (callId with no matching tool result)
  const danglingToolUseIndices: number[] = [];
  for (const [callId, idx] of assistantByCallId) {
    if (!matchedCallIds.has(callId)) {
      danglingToolUseIndices.push(idx);
    }
  }
  // Sort dangling indices for deterministic output
  danglingToolUseIndices.sort((a, b) => a - b);

  return { assistantByCallId, orphanToolIndices, danglingToolUseIndices };
}
