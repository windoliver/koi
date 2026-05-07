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
    const sender = normalizeE164(event.source);
    // For DMs the threadId IS the sender E.164 — outbound send() rejects
    // any non-group threadId that is not valid E.164. If signal-cli ever
    // emits a source we cannot coerce to E.164 (truncated, anonymized,
    // username-only), drop the inbound message rather than handing the
    // agent a thread it cannot reply on. Group messages route by groupId
    // independently of sender, so they remain deliverable even when the
    // sender's source cannot be normalized.
    if (sender === null && event.groupId === undefined) return null;
    const senderId = sender ?? event.source;
    const threadId =
      event.groupId !== undefined ? `${GROUP_THREAD_PREFIX}${event.groupId}` : senderId;
    return {
      content: [{ kind: "text", text: event.body }],
      senderId,
      threadId,
      timestamp: event.timestamp,
    };
  };
}
