/**
 * Normalizer tests — TranscriptEvent → InboundMessage.
 */

import { describe, expect, test } from "bun:test";
import { normalizeTranscript } from "./normalize.js";
import type { TranscriptEvent } from "./pipeline.js";

const ROOM = "voice-test-room";

function makeTranscript(overrides?: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    text: "Hello world",
    isFinal: true,
    participantId: "user-1",
    confidence: 0.95,
    ...overrides,
  };
}

describe("normalizeTranscript", () => {
  test("final transcript produces InboundMessage with TextBlock", () => {
    const result = normalizeTranscript(makeTranscript(), ROOM, false);
    expect(result).not.toBeNull();
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({ kind: "text", text: "Hello world" });
    expect(result?.senderId).toBe("user-1");
    expect(result?.threadId).toBe(ROOM);
    expect(result?.timestamp).toBeGreaterThan(0);
  });

  test("non-final transcript returns null", () => {
    const result = normalizeTranscript(makeTranscript({ isFinal: false }), ROOM, false);
    expect(result).toBeNull();
  });

  test("empty string returns null", () => {
    const result = normalizeTranscript(makeTranscript({ text: "" }), ROOM, false);
    expect(result).toBeNull();
  });

  test("whitespace-only string returns null", () => {
    const result = normalizeTranscript(makeTranscript({ text: "   \t\n  " }), ROOM, false);
    expect(result).toBeNull();
  });

  test("debug=true includes confidence in metadata", () => {
    const result = normalizeTranscript(makeTranscript({ confidence: 0.87 }), ROOM, true);
    expect(result).not.toBeNull();
    expect(result?.metadata).toEqual({ confidence: 0.87 });
  });

  test("debug=false excludes confidence from metadata", () => {
    const result = normalizeTranscript(makeTranscript({ confidence: 0.87 }), ROOM, false);
    expect(result).not.toBeNull();
    expect(result?.metadata).toBeUndefined();
  });

  test("debug=true with no confidence omits metadata", () => {
    const { confidence: _, ...withoutConfidence } = makeTranscript();
    const result = normalizeTranscript(withoutConfidence, ROOM, true);
    expect(result).not.toBeNull();
    expect(result?.metadata).toBeUndefined();
  });

  test("long text (>10K chars) still emits", () => {
    const longText = "a".repeat(15_000);
    const result = normalizeTranscript(makeTranscript({ text: longText }), ROOM, false);
    expect(result).not.toBeNull();
    expect(result?.content[0]).toEqual({ kind: "text", text: longText });
  });

  test("uses participantId as senderId", () => {
    const result = normalizeTranscript(
      makeTranscript({ participantId: "speaker-42" }),
      ROOM,
      false,
    );
    expect(result?.senderId).toBe("speaker-42");
  });

  test("uses roomName as threadId", () => {
    const result = normalizeTranscript(makeTranscript(), "my-room", false);
    expect(result?.threadId).toBe("my-room");
  });
});
