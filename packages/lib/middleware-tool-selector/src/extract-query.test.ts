import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { extractLastUserText } from "./extract-query.js";

function msg(blocks: InboundMessage["content"]): InboundMessage {
  return { content: blocks, senderId: "user", timestamp: 0 };
}

describe("extractLastUserText", () => {
  test("returns empty string when message list is empty", () => {
    expect(extractLastUserText([])).toBe("");
  });

  test("returns text of the last message's text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([{ kind: "text", text: "first" }]),
      msg([{ kind: "text", text: "deploy the app" }]),
    ];
    expect(extractLastUserText(messages)).toBe("deploy the app");
  });

  test("joins multiple text blocks with a single space", () => {
    const messages: readonly InboundMessage[] = [
      msg([
        { kind: "text", text: "hello" },
        { kind: "text", text: "world" },
      ]),
    ];
    expect(extractLastUserText(messages)).toBe("hello world");
  });

  test("ignores non-text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([
        { kind: "image", url: "https://example.com/x.png" },
        { kind: "text", text: "caption" },
      ]),
    ];
    expect(extractLastUserText(messages)).toBe("caption");
  });

  test("returns empty string when last message has no text blocks", () => {
    const messages: readonly InboundMessage[] = [
      msg([{ kind: "image", url: "https://example.com/x.png" }]),
    ];
    expect(extractLastUserText(messages)).toBe("");
  });
});
