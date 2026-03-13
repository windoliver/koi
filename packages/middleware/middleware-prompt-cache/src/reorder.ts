/**
 * Message reordering for cache-friendly prefix ordering.
 *
 * Optimal ordering: system messages (stable) → tool results (semi-stable) → user messages (dynamic).
 * The goal: maximize the shared prefix across consecutive model calls so that
 * provider-level prompt caching can reuse the cached prefix.
 *
 * Within each group, original order is preserved (stable sort).
 */

import type { InboundMessage } from "@koi/core";

/**
 * Classify a message as static (system-origin — stable across turns)
 * or dynamic (user/assistant/tool — changes each turn).
 *
 * Only system messages (senderId starts with "system") are static.
 * Assistant messages are part of the conversation history and must NOT
 * be reordered — moving them would break model turn semantics.
 */
function isStaticMessage(message: InboundMessage): boolean {
  return message.senderId.startsWith("system");
}

export interface ReorderResult {
  /** Reordered messages: static prefix first, then dynamic suffix. */
  readonly messages: readonly InboundMessage[];
  /** Index of the last static message (inclusive). -1 if no static messages. */
  readonly lastStableIndex: number;
  /** Count of static messages in the prefix. */
  readonly staticCount: number;
}

/**
 * Reorder messages for cache-friendly prefix ordering.
 *
 * Partitions messages into static (system/assistant) and dynamic (user/tool),
 * preserving relative order within each group.
 *
 * Returns the reordered array and metadata about the split point.
 */
export function reorderForCache(messages: readonly InboundMessage[]): ReorderResult {
  if (messages.length === 0) {
    return { messages: [], lastStableIndex: -1, staticCount: 0 };
  }

  const staticMessages: InboundMessage[] = [];
  const dynamicMessages: InboundMessage[] = [];

  for (const msg of messages) {
    if (isStaticMessage(msg)) {
      staticMessages.push(msg);
    } else {
      dynamicMessages.push(msg);
    }
  }

  const staticCount = staticMessages.length;
  const reordered = [...staticMessages, ...dynamicMessages];

  return {
    messages: reordered,
    lastStableIndex: staticCount > 0 ? staticCount - 1 : -1,
    staticCount,
  };
}

/**
 * Rough token estimate for messages (4 chars ≈ 1 token).
 * Used to check if the static prefix meets the minimum threshold.
 */
export function estimateTokens(messages: readonly InboundMessage[]): number {
  let charCount = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.kind === "text") {
        charCount += block.text.length;
      }
    }
  }
  return Math.ceil(charCount / 4);
}
