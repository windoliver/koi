/**
 * Session repair pipeline — 3-phase message history repair.
 *
 * Phase 1 (orphan repair): Insert synthetic messages to pair orphan tools / dangling tool_use.
 * Phase 2 (dedup): Remove consecutive duplicate messages (lazy hashing).
 * Phase 3 (merge): Merge consecutive same-sender messages when safe.
 *
 * Pure function — no side effects, no I/O.
 */

import type { InboundMessage } from "@koi/core/message";
import { computeContentHash } from "@koi/hash";
import { isMergeable, readStringMeta } from "./internal.js";
import { mapCallIdPairs } from "./map-call-id-pairs.js";
import type { RepairIssue, RepairResult } from "./types.js";

// ---------------------------------------------------------------------------
// Phase 1: Orphan repair
// ---------------------------------------------------------------------------

function repairOrphans(
  messages: readonly InboundMessage[],
  issues: RepairIssue[],
): readonly InboundMessage[] {
  const pairs = mapCallIdPairs(messages);
  if (pairs.orphanToolIndices.length === 0 && pairs.danglingToolUseIndices.length === 0) {
    return messages;
  }

  const orphanSet = new Set(pairs.orphanToolIndices);
  const danglingSet = new Set(pairs.danglingToolUseIndices);
  const result: InboundMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;

    if (orphanSet.has(i)) {
      // Insert synthetic assistant before orphan tool
      const callId = readStringMeta(msg.metadata, "callId") ?? "unknown";
      const synthetic: InboundMessage = {
        senderId: "assistant",
        content: [{ kind: "text", text: "[Tool call reconstructed during session repair]" }],
        metadata: { callId, synthetic: true, repairPhase: "orphan-tool" },
        timestamp: msg.timestamp,
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      };
      result.push(synthetic);
      issues.push({
        phase: "orphan-tool",
        description: `Inserted synthetic assistant for orphan tool at index ${String(i)} (callId: ${callId})`,
        index: i,
        action: "inserted",
      });
    }

    result.push(msg);

    if (danglingSet.has(i)) {
      // Insert synthetic tool after dangling assistant
      const callId = readStringMeta(msg.metadata, "callId") ?? "unknown";
      const synthetic: InboundMessage = {
        senderId: "tool",
        content: [{ kind: "text", text: "[Tool result lost during session repair]" }],
        metadata: { callId, synthetic: true, repairPhase: "orphan-tool" },
        timestamp: msg.timestamp,
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      };
      result.push(synthetic);
      issues.push({
        phase: "orphan-tool",
        description: `Inserted synthetic tool result for dangling assistant at index ${String(i)} (callId: ${callId})`,
        index: i,
        action: "inserted",
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: Dedup
// ---------------------------------------------------------------------------

function dedup(
  messages: readonly InboundMessage[],
  issues: RepairIssue[],
): readonly InboundMessage[] {
  if (messages.length < 2) return messages;

  const first = messages[0];
  if (first === undefined) return messages;
  const result: InboundMessage[] = [first];
  // let justified: cache of last hash, recomputed only when senderId matches
  let lastHash: string | undefined;

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev === undefined || curr === undefined) continue;

    if (prev.senderId === curr.senderId) {
      // Lazy hashing: only hash when same-senderId adjacency found
      if (lastHash === undefined) {
        lastHash = computeContentHash(prev.content);
      }
      const currHash = computeContentHash(curr.content);
      if (lastHash === currHash) {
        issues.push({
          phase: "dedup",
          description: `Removed duplicate message at index ${String(i)} (senderId: ${curr.senderId})`,
          index: i,
          action: "removed",
        });
        // Keep prev (already in result), skip curr, lastHash stays the same
        continue;
      }
      lastHash = currHash;
    } else {
      lastHash = undefined;
    }

    result.push(curr);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 3: Merge
// ---------------------------------------------------------------------------

function merge(
  messages: readonly InboundMessage[],
  issues: RepairIssue[],
): readonly InboundMessage[] {
  if (messages.length < 2) return messages;

  const first = messages[0];
  if (first === undefined) return messages;
  const result: InboundMessage[] = [first];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev === undefined || curr === undefined) continue;

    if (prev.senderId === curr.senderId && isMergeable(prev) && isMergeable(curr)) {
      // Merge: concatenate content, keep first message's metadata/timestamp
      const merged: InboundMessage = {
        ...prev,
        content: [...prev.content, ...curr.content],
      };
      // let justified: local accumulator array, replaced element is not shared outside this function
      result[result.length - 1] = merged;
      issues.push({
        phase: "merge",
        description: `Merged consecutive ${curr.senderId} message at index ${String(i)}`,
        index: i,
        action: "merged",
      });
    } else {
      result.push(curr);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Repair a session message history.
 *
 * Runs 3 phases: orphan repair -> dedup -> merge.
 * Returns original array reference when no repairs are needed (zero allocation).
 */
export function repairSession(messages: readonly InboundMessage[]): RepairResult {
  if (messages.length === 0) {
    return { messages, issues: [] };
  }

  const issues: RepairIssue[] = [];

  // Phase 1: orphan repair
  const afterOrphan = repairOrphans(messages, issues);

  // Phase 2: dedup
  const afterDedup = dedup(afterOrphan, issues);

  // Phase 3: merge
  const afterMerge = merge(afterDedup, issues);

  // Zero-allocation fast path: if no issues, return original reference
  if (issues.length === 0) {
    return { messages, issues: [] };
  }

  return { messages: afterMerge, issues };
}
