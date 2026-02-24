/**
 * Pure function that clears old tool result content from message history.
 *
 * When the total token count exceeds a configurable threshold, replaces
 * old tool result content with a placeholder string. Preserves the most
 * recent N tool results and any tools in the exclude list.
 */

import type { JsonObject } from "@koi/core/common";
import type { ContentBlock, InboundMessage } from "@koi/core/message";
import type { ResolvedContextEditingConfig } from "./types.js";

/** Safely reads a string value from metadata, returning undefined if not a string. */
function readStringMeta(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Identifies indices of tool result messages eligible for clearing.
 *
 * A message is a tool result when its `senderId` is `"tool"`.
 * Returns indices in ascending order (oldest first).
 */
function findToolResultIndices(
  messages: readonly InboundMessage[],
  excludeTools: ReadonlySet<string>,
): readonly number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined || msg.senderId !== "tool") {
      continue;
    }
    const toolName = readStringMeta(msg.metadata, "toolName") ?? "";
    if (excludeTools.has(toolName)) {
      continue;
    }
    indices.push(i);
  }
  return indices;
}

/**
 * Finds the assistant message index containing a matching tool call ID.
 * Searches backwards from `fromIndex` for efficiency (assistant message
 * typically precedes its tool result).
 */
function findToolCallMessageIndex(
  messages: readonly InboundMessage[],
  callId: string,
  fromIndex: number,
): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined) {
      continue;
    }
    const msgCallId =
      readStringMeta(msg.metadata, "callId") ?? readStringMeta(msg.metadata, "toolCallId");
    if (msgCallId === callId) {
      return i;
    }
  }
  return -1;
}

/** Creates a cleared content block array with the given placeholder text. */
function clearedContent(placeholder: string): readonly ContentBlock[] {
  return [{ kind: "text", text: placeholder }];
}

/**
 * Edits a message array by clearing old tool result content.
 *
 * Pure function — returns a new array with replaced messages. The original
 * array and its messages are never mutated. When no edits are needed,
 * returns the original array reference (zero allocation fast path).
 *
 * Algorithm:
 * 1. If tokenCount <= triggerTokenCount, return original (fast path)
 * 2. Find all non-excluded tool result message indices
 * 3. Remove the last N from candidates (preserve recent)
 * 4. Replace candidate content with placeholder
 * 5. Optionally clear corresponding assistant tool call messages
 */
export function editMessages(
  messages: readonly InboundMessage[],
  tokenCount: number,
  config: ResolvedContextEditingConfig,
): readonly InboundMessage[] {
  // Fast path: below threshold — zero allocation
  if (tokenCount <= config.triggerTokenCount) {
    return messages;
  }

  const toolResultIndices = findToolResultIndices(messages, config.excludeTools);

  // Nothing to clear
  if (toolResultIndices.length === 0) {
    return messages;
  }

  // Preserve the last N tool results (independent of exclusion — T1-A)
  const candidateCount = toolResultIndices.length - config.numRecentToKeep;
  if (candidateCount <= 0) {
    return messages;
  }

  const candidateIndices = toolResultIndices.slice(0, candidateCount);
  const candidateSet = new Set(candidateIndices);

  // Also track assistant message indices to clear if clearToolCallInputs is on
  const assistantIndicesToClear = new Set<number>();

  if (config.clearToolCallInputs) {
    for (const idx of candidateIndices) {
      const msg = messages[idx];
      if (msg === undefined) {
        continue;
      }
      const callId =
        readStringMeta(msg.metadata, "callId") ?? readStringMeta(msg.metadata, "toolCallId");
      if (callId !== undefined) {
        const assistantIdx = findToolCallMessageIndex(messages, callId, idx);
        if (assistantIdx >= 0) {
          assistantIndicesToClear.add(assistantIdx);
        }
      }
    }
  }

  // Build new array — only create new message objects for cleared indices
  const placeholder = clearedContent(config.placeholder);
  return messages.map((msg, i) => {
    if (candidateSet.has(i) || assistantIndicesToClear.has(i)) {
      return { ...msg, content: placeholder };
    }
    return msg;
  });
}
