import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { textOf } from "./text-of.js";

function msg(content: InboundMessage["content"]): InboundMessage {
  return { senderId: "u1", timestamp: 0, content };
}

describe("textOf", () => {
  test("returns empty string for empty content array", () => {
    expect(textOf(msg([]))).toBe("");
  });

  test("returns text from single text block", () => {
    expect(textOf(msg([{ kind: "text", text: "hello" }]))).toBe("hello");
  });

  test("joins multiple text blocks with newline", () => {
    const result = textOf(
      msg([
        { kind: "text", text: "line one" },
        { kind: "text", text: "line two" },
      ]),
    );
    expect(result).toBe("line one\nline two");
  });

  test("filters out non-text blocks", () => {
    const result = textOf(
      msg([
        { kind: "text", text: "before" },
        { kind: "image", url: "https://example.com/img.png" },
        { kind: "text", text: "after" },
      ]),
    );
    expect(result).toBe("before\nafter");
  });

  test("returns empty string when no text blocks exist", () => {
    const result = textOf(
      msg([
        { kind: "image", url: "https://example.com/img.png" },
        { kind: "button", label: "click", action: "do" },
      ]),
    );
    expect(result).toBe("");
  });
});
