/**
 * Maps ThreadMessage (L0) → InboundMessage with fromHistory metadata.
 */
import type { InboundMessage, TextBlock, ThreadMessage } from "@koi/core";

/**
 * Convert a stored ThreadMessage to an InboundMessage suitable for
 * model call injection. All mapped messages carry `fromHistory: true`
 * in their metadata so the middleware can distinguish them from
 * live session messages.
 */
export function mapThreadMessageToInbound(
  msg: ThreadMessage,
  agentId: string,
  userId?: string,
): InboundMessage {
  const senderId =
    msg.role === "assistant"
      ? agentId
      : msg.role === "user"
        ? (userId ?? "user")
        : msg.role === "system"
          ? "system"
          : "tool";

  const textBlock: TextBlock = { kind: "text", text: msg.content };

  return {
    content: [textBlock],
    senderId,
    timestamp: msg.createdAt,
    metadata: { ...(msg.metadata ?? {}), fromHistory: true },
  };
}
