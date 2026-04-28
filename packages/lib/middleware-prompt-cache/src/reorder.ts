/**
 * Reorder messages for cache-friendly prefix ordering.
 *
 * Static messages (system) float to the front, preserving the relative order
 * of dynamic messages (assistant, user, tool). Reordering assistant messages
 * would corrupt conversation turn semantics — they MUST keep their input order.
 */

import type { InboundMessage } from "@koi/core";

function isStaticMessage(message: InboundMessage): boolean {
  return message.senderId.startsWith("system");
}

export interface ReorderResult {
  readonly messages: readonly InboundMessage[];
  /** Index of the last static message in the output. -1 if none. */
  readonly lastStableIndex: number;
  readonly staticCount: number;
}

export function reorderForCache(messages: readonly InboundMessage[]): ReorderResult {
  if (messages.length === 0) {
    return { messages: [], lastStableIndex: -1, staticCount: 0 };
  }

  const staticMessages: InboundMessage[] = [];
  const dynamicMessages: InboundMessage[] = [];

  for (const msg of messages) {
    if (isStaticMessage(msg)) staticMessages.push(msg);
    else dynamicMessages.push(msg);
  }

  const staticCount = staticMessages.length;
  return {
    messages: [...staticMessages, ...dynamicMessages],
    lastStableIndex: staticCount > 0 ? staticCount - 1 : -1,
    staticCount,
  };
}
