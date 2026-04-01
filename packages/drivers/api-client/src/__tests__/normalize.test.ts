import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { extractSystemAndMessages, mapSenderIdToRole, toAnthropicContent } from "../normalize.js";

// ---------------------------------------------------------------------------
// mapSenderIdToRole
// ---------------------------------------------------------------------------

describe("mapSenderIdToRole", () => {
  test("maps 'assistant' to assistant", () => {
    expect(mapSenderIdToRole("assistant")).toBe("assistant");
  });

  test("maps 'system' to system", () => {
    expect(mapSenderIdToRole("system")).toBe("system");
  });

  test("maps 'system:*' prefix to system", () => {
    expect(mapSenderIdToRole("system:instructions")).toBe("system");
  });

  test("maps any other senderId to user", () => {
    expect(mapSenderIdToRole("user-123")).toBe("user");
    expect(mapSenderIdToRole("channel-abc")).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// toAnthropicContent
// ---------------------------------------------------------------------------

describe("toAnthropicContent", () => {
  test("returns plain string for text-only content", () => {
    const result = toAnthropicContent([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
    ]);
    expect(result).toBe("Hello world");
  });

  test("returns array with image blocks for mixed content", () => {
    const result = toAnthropicContent([
      { kind: "text", text: "Look at this:" },
      { kind: "image", url: "https://example.com/img.png" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const parts = result as readonly { type: string }[];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]?.type).toBe("image");
  });

  test("handles base64 data URL images", () => {
    const result = toAnthropicContent([{ kind: "image", url: "data:image/png;base64,abc123" }]);
    const parts = result as readonly { type: string; source?: { type: string } }[];
    expect(parts[0]?.type).toBe("image");
    expect(parts[0]?.source?.type).toBe("base64");
  });

  test("converts file blocks to text fallback", () => {
    const result = toAnthropicContent([
      { kind: "file", url: "file:///doc.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    ]);
    expect(result).toBe("[file: doc.pdf]");
  });

  test("converts button blocks to text fallback", () => {
    const result = toAnthropicContent([{ kind: "button", label: "Click me", action: "submit" }]);
    expect(result).toBe("[button: Click me]");
  });

  test("converts custom blocks to text fallback", () => {
    const result = toAnthropicContent([{ kind: "custom", type: "widget", data: {} }]);
    expect(result).toBe("[widget]");
  });
});

// ---------------------------------------------------------------------------
// extractSystemAndMessages
// ---------------------------------------------------------------------------

describe("extractSystemAndMessages", () => {
  const ts = Date.now();

  function msg(senderId: string, text: string): InboundMessage {
    return {
      content: [{ kind: "text", text }],
      senderId,
      timestamp: ts,
    };
  }

  test("extracts system messages into system string", () => {
    const result = extractSystemAndMessages([
      msg("system", "You are helpful."),
      msg("user-1", "Hello"),
    ]);

    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  test("joins multiple system messages", () => {
    const result = extractSystemAndMessages([
      msg("system", "Rule 1"),
      msg("system:extra", "Rule 2"),
      msg("user-1", "Hi"),
    ]);

    expect(result.system).toBe("Rule 1\n\nRule 2");
  });

  test("returns undefined system when no system messages", () => {
    const result = extractSystemAndMessages([msg("user-1", "Hello"), msg("assistant", "Hi there")]);

    expect(result.system).toBeUndefined();
  });

  test("merges consecutive same-role messages", () => {
    const result = extractSystemAndMessages([
      msg("user-1", "First"),
      msg("user-2", "Second"),
      msg("assistant", "Reply"),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("First\nSecond");
    expect(result.messages[1]?.role).toBe("assistant");
  });

  test("preserves alternating roles", () => {
    const result = extractSystemAndMessages([
      msg("user-1", "Q1"),
      msg("assistant", "A1"),
      msg("user-1", "Q2"),
      msg("assistant", "A2"),
    ]);

    expect(result.messages).toHaveLength(4);
  });

  test("handles empty messages array", () => {
    const result = extractSystemAndMessages([]);
    expect(result.system).toBeUndefined();
    expect(result.messages).toHaveLength(0);
  });
});
