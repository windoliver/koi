/**
 * Shared internal helpers for the session repair pipeline.
 */

import type { InboundMessage } from "@koi/core/message";

/** Safely reads a string value from message metadata. */
export function readStringMeta(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Check if a message is eligible for merging (no callId, not pinned, not synthetic, not tool). */
export function isMergeable(msg: InboundMessage): boolean {
  if (readStringMeta(msg.metadata, "callId") !== undefined) return false;
  if (msg.senderId === "tool") return false;
  if (msg.pinned === true) return false;
  if (msg.metadata?.synthetic === true) return false;
  return true;
}
