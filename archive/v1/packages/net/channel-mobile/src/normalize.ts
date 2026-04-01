/**
 * Normalizes WebSocket inbound frames to InboundMessage.
 *
 * Returns null for non-message frames (ping, auth, tool_result).
 */

import type { MessageNormalizer } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { MobileInboundFrame } from "./protocol.js";

/**
 * Creates a normalizer that converts MobileInboundFrame to InboundMessage.
 * Non-message frames (ping, auth, tool_result) return null.
 */
export function createNormalizer(): MessageNormalizer<MobileInboundFrame> {
  return (frame: MobileInboundFrame): InboundMessage | null => {
    if (frame.kind !== "message") {
      return null;
    }

    if (frame.content.length === 0) {
      return null;
    }

    return {
      content: frame.content,
      senderId: frame.senderId,
      timestamp: Date.now(),
      ...(frame.threadId !== undefined ? { threadId: frame.threadId } : {}),
    };
  };
}
