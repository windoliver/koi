import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, ModelHandler } from "@koi/core";
import { compactHistory, shouldCompact } from "./compaction.js";
import { createTokenTracker } from "./token-tracker.js";

function makeMessage(text: string, senderId: string = "user"): InboundMessage {
  return {
    content: [{ kind: "text" as const, text }],
    senderId,
    timestamp: Date.now(),
  };
}

describe("shouldCompact", () => {
  test("returns false below threshold", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(70);
    expect(shouldCompact(tracker, 0.8)).toBe(false);
  });

  test("returns true at threshold", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(80);
    expect(shouldCompact(tracker, 0.8)).toBe(true);
  });

  test("returns true above threshold", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(90);
    expect(shouldCompact(tracker, 0.8)).toBe(true);
  });

  test("uses default threshold of 0.8", () => {
    const tracker = createTokenTracker(100);
    tracker.addTokens(79);
    expect(shouldCompact(tracker)).toBe(false);
    tracker.addTokens(1);
    expect(shouldCompact(tracker)).toBe(true);
  });
});

describe("compactHistory", () => {
  test("returns empty array for empty messages", async () => {
    const modelCall = mock(() => Promise.resolve({ content: "summary", model: "test" }));
    const result = await compactHistory([], modelCall);
    expect(result).toEqual([]);
    expect(modelCall).not.toHaveBeenCalled();
  });

  test("compacts messages into a single summary", async () => {
    const modelCall: ModelHandler = mock(() =>
      Promise.resolve({
        content: "Summarized: user asked about X, assistant found Y",
        model: "test",
      }),
    );

    const messages: readonly InboundMessage[] = [
      makeMessage("What is X?"),
      makeMessage("X is related to Y", "assistant"),
    ];

    const result = await compactHistory(messages, modelCall);
    expect(result).toHaveLength(1);
    expect(result[0]?.content[0]?.kind).toBe("text");
    if (result[0]?.content[0]?.kind === "text") {
      expect(result[0].content[0].text).toBe("Summarized: user asked about X, assistant found Y");
    }
    expect(result[0]?.senderId).toBe("assistant");
    expect(result[0]?.pinned).toBe(true);
  });

  test("output is shorter than input (property test)", async () => {
    const longMessages: readonly InboundMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeMessage(`This is message number ${String(i)} with some extra content to make it longer.`),
    );

    const modelCall: ModelHandler = mock(() =>
      Promise.resolve({ content: "Brief summary.", model: "test" }),
    );

    const result = await compactHistory(longMessages, modelCall);
    const inputLength = longMessages.reduce(
      (sum, m) => sum + m.content.reduce((s, b) => s + (b.kind === "text" ? b.text.length : 0), 0),
      0,
    );
    const outputLength = result.reduce(
      (sum, m) => sum + m.content.reduce((s, b) => s + (b.kind === "text" ? b.text.length : 0), 0),
      0,
    );
    expect(outputLength).toBeLessThan(inputLength);
  });

  test("fail-safe returns original on model error", async () => {
    const modelCall: ModelHandler = mock(() => Promise.reject(new Error("Model down")));

    const messages: readonly InboundMessage[] = [makeMessage("Hello")];
    const result = await compactHistory(messages, modelCall);
    expect(result).toBe(messages);
  });

  test("passes model identifier when provided", async () => {
    const modelCall: ModelHandler = mock(() =>
      Promise.resolve({ content: "Summary", model: "test" }),
    );

    await compactHistory([makeMessage("test")], modelCall, "gpt-4");

    expect(modelCall).toHaveBeenCalledTimes(1);
    const callArg = (modelCall as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.model).toBe("gpt-4");
  });

  test("includes tool messages in transcript", async () => {
    const modelCall: ModelHandler = mock((req) => {
      const text = req.messages[0]?.content[0];
      if (text?.kind === "text" && text.text.includes("Tool:")) {
        return Promise.resolve({ content: "Summary with tool info", model: "test" });
      }
      return Promise.resolve({ content: "Missing tool info", model: "test" });
    });

    const messages: readonly InboundMessage[] = [
      makeMessage("Use the search tool"),
      makeMessage("Search result: found 3 items", "tool"),
    ];

    const result = await compactHistory(messages, modelCall);
    expect(result).toHaveLength(1);
    if (result[0]?.content[0]?.kind === "text") {
      expect(result[0].content[0].text).toBe("Summary with tool info");
    }
  });
});
