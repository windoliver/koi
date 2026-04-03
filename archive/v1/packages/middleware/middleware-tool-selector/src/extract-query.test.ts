import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { extractLastUserText } from "./extract-query.js";

function msg(text: string): InboundMessage {
  return {
    senderId: "user-1",
    timestamp: Date.now(),
    content: [{ kind: "text" as const, text }],
  };
}

describe("extractLastUserText", () => {
  test("extracts text from last message", () => {
    const messages: readonly InboundMessage[] = [msg("first"), msg("second")];
    expect(extractLastUserText(messages)).toBe("second");
  });

  test("returns empty string when no messages", () => {
    expect(extractLastUserText([])).toBe("");
  });

  test("handles messages with multiple content blocks", () => {
    const message: InboundMessage = {
      senderId: "user-1",
      timestamp: Date.now(),
      content: [
        { kind: "text" as const, text: "hello" },
        { kind: "text" as const, text: "world" },
      ],
    };
    expect(extractLastUserText([message])).toBe("hello world");
  });

  test("ignores non-text content blocks", () => {
    const message: InboundMessage = {
      senderId: "user-1",
      timestamp: Date.now(),
      content: [
        { kind: "text" as const, text: "hello" },
        { kind: "image" as const, url: "http://example.com/img.png" },
      ],
    };
    expect(extractLastUserText([message])).toBe("hello");
  });

  test("returns empty string when last message has no text blocks", () => {
    const message: InboundMessage = {
      senderId: "user-1",
      timestamp: Date.now(),
      content: [{ kind: "image" as const, url: "http://example.com/img.png" }],
    };
    expect(extractLastUserText([message])).toBe("");
  });
});
