/**
 * Shared test helpers for @koi/context-manager tests.
 *
 * Provides message factories and mock estimators used across
 * multiple test files. Single source of truth — update here
 * when InboundMessage structure changes.
 */

import type { InboundMessage, TokenEstimator } from "@koi/core";

/**
 * Create a message with specific text content.
 * Use in tests that care about token counts / text length.
 */
export function textMsg(
  text: string,
  sender = "user",
  callId?: string,
  pinned?: boolean,
): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: sender,
    timestamp: Date.now(),
    ...(callId !== undefined ? { metadata: { callId } } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
  };
}

/**
 * Create a message with default content ("content").
 * Use in tests that care about structure, not text length.
 */
export function structMsg(sender: string, callId?: string, pinned?: boolean): InboundMessage {
  return {
    content: [{ kind: "text", text: "content" }],
    senderId: sender,
    timestamp: Date.now(),
    ...(callId !== undefined ? { metadata: { callId } } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
  };
}

/**
 * Create an assistant message with a tool_use content block.
 */
export function assistantWithToolUse(callId: string, pinned?: boolean): InboundMessage {
  return {
    content: [{ kind: "custom", type: "tool_use", data: { id: callId, name: "test" } }],
    senderId: "assistant",
    timestamp: Date.now(),
    metadata: { callId },
    ...(pinned !== undefined ? { pinned } : {}),
  };
}

/** Simple estimator: 1 char = 1 token. No overhead. */
export const charEstimator: TokenEstimator = {
  estimateText(text: string): number {
    return text.length;
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0; // let: accumulator
    for (const m of messages) {
      for (const b of m.content) {
        if (b.kind === "text") {
          total += b.text.length;
        }
      }
    }
    return total;
  },
};

/**
 * Estimator with per-sequence overhead: adds 10 tokens once per
 * estimateMessages() call. sum(est([m_i])) > est([m_1, ..., m_n]).
 */
export const overheadEstimator: TokenEstimator = {
  estimateText(text: string): number {
    return text.length;
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    const SEQUENCE_OVERHEAD = 10;
    let total = SEQUENCE_OVERHEAD; // let: accumulator
    for (const m of messages) {
      for (const b of m.content) {
        if (b.kind === "text") {
          total += b.text.length;
        }
      }
    }
    return total;
  },
};
