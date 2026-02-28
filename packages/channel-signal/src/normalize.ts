/**
 * Normalizes signal-cli JSON events to InboundMessage.
 *
 * Returns null for receipt and typing events.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import { text } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import { normalizeE164 } from "./e164.js";
import type { SignalEvent } from "./signal-process.js";

/**
 * Creates a normalizer that converts SignalEvent to InboundMessage.
 * Receipt and typing events return null.
 */
export function createNormalizer(): MessageNormalizer<SignalEvent> {
  return (event: SignalEvent): InboundMessage | null => {
    if (event.kind !== "message") {
      return null;
    }

    if (event.body.length === 0) {
      return null;
    }

    // Normalize phone numbers to E.164 (OpenClaw pattern)
    const normalizedSource = normalizeE164(event.source) ?? event.source;

    // ThreadId: group ID for group messages, normalized phone number for DMs
    const threadId = event.groupId ?? normalizedSource;

    return {
      content: [text(event.body)],
      senderId: normalizedSource,
      threadId,
      timestamp: event.timestamp,
    };
  };
}
