/**
 * SignalEvent → InboundMessage normalization.
 *
 * - DM messages: senderId = E.164-normalized source, threadId = same E.164.
 * - Group messages: threadId = "group:<groupId>" so outbound `send()` can
 *   distinguish DMs from groups by prefix.
 * - Receipt + typing events: dropped (return null).
 */

import type { InboundMessage } from "@koi/core";
import { normalizeE164 } from "./e164.js";
import type { SignalEvent } from "./signal-process.js";

/** Prefix marking a group threadId. */
export const GROUP_THREAD_PREFIX = "group:";

export function createNormalizer(): (event: SignalEvent) => InboundMessage | null {
  return (event: SignalEvent): InboundMessage | null => {
    if (event.kind !== "message") return null;
    if (event.body.length === 0) return null;
    const sender = normalizeE164(event.source) ?? event.source;
    const threadId =
      event.groupId !== undefined ? `${GROUP_THREAD_PREFIX}${event.groupId}` : sender;
    return {
      content: [{ kind: "text", text: event.body }],
      senderId: sender,
      threadId,
      timestamp: event.timestamp,
    };
  };
}
