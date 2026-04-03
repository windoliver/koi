/**
 * TranscriptEvent → InboundMessage normalizer.
 *
 * Maps final transcripts to InboundMessages with TextBlock content.
 * Ignores non-final transcripts and empty/whitespace-only text.
 * threadId is set to the room name to correlate messages within a session.
 */

import { text } from "@koi/channel-base";
import type { InboundMessage, JsonObject } from "@koi/core";
import type { TranscriptEvent } from "./pipeline.js";

/**
 * Creates a normalizer that maps TranscriptEvents to InboundMessages.
 *
 * @param roomName - The room name used as threadId for message correlation.
 * @param debug - When true, includes confidence score in metadata.
 * @returns InboundMessage or null (for ignored events).
 */
export function normalizeTranscript(
  event: TranscriptEvent,
  roomName: string,
  debug: boolean,
): InboundMessage | null {
  // Only final transcripts trigger agent turns
  if (!event.isFinal) {
    return null;
  }

  // Ignore empty or whitespace-only transcripts
  const trimmed = event.text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const metadata: JsonObject | undefined =
    debug && event.confidence !== undefined ? { confidence: event.confidence } : undefined;

  return {
    content: [text(event.text)],
    senderId: event.participantId,
    threadId: roomName,
    timestamp: Date.now(),
    ...(metadata !== undefined && { metadata }),
  };
}
