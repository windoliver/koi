import { describe, expect, test } from "bun:test";
import type { ContentBlock, InboundMessage } from "@koi/core/message";
import { sanitizeBlock, sanitizeMessage, sanitizeString } from "./sanitize-block.js";
import type { SanitizeRule } from "./types.js";

const STRIP_RULE: SanitizeRule = {
  name: "test-strip",
  pattern: /badword/i,
  action: { kind: "strip", replacement: "[redacted]" },
};

const BLOCK_RULE: SanitizeRule = {
  name: "test-block",
  pattern: /evil/i,
  action: { kind: "block", reason: "blocked content" },
};

const FLAG_RULE: SanitizeRule = {
  name: "test-flag",
  pattern: /suspicious/i,
  action: { kind: "flag", replacement: "[flagged]", tag: "sus" },
};

const TEXT_ONLY_RULE: SanitizeRule = {
  name: "text-only",
  pattern: /secret/i,
  action: { kind: "strip", replacement: "" },
  targets: ["text"],
};

describe("sanitizeString", () => {
  test("strips matching content", () => {
    const result = sanitizeString("hello badword world", [STRIP_RULE], "input");
    expect(result.text).toBe("hello [redacted] world");
    expect(result.blocked).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  test("flags matching content", () => {
    const result = sanitizeString("suspicious activity", [FLAG_RULE], "input");
    expect(result.text).toBe("[flagged] activity");
    expect(result.blocked).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.rule.name).toBe("test-flag");
  });

  test("sets blocked on block action", () => {
    const result = sanitizeString("something evil here", [BLOCK_RULE], "input");
    expect(result.blocked).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  test("returns unchanged text when no rules match", () => {
    const result = sanitizeString("hello world", [STRIP_RULE], "input");
    expect(result.text).toBe("hello world");
    expect(result.blocked).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  test("applies multiple rules", () => {
    const result = sanitizeString("badword and suspicious", [STRIP_RULE, FLAG_RULE], "input");
    expect(result.text).toBe("[redacted] and [flagged]");
    expect(result.events).toHaveLength(2);
  });

  test("handles empty text", () => {
    const result = sanitizeString("", [STRIP_RULE], "input");
    expect(result.text).toBe("");
    expect(result.events).toHaveLength(0);
  });

  test("pre-filters by target block kind", () => {
    const result = sanitizeString("secret data", [TEXT_ONLY_RULE], "input", "file");
    expect(result.text).toBe("secret data");
    expect(result.events).toHaveLength(0);
  });

  test("applies rule when target matches block kind", () => {
    const result = sanitizeString("secret data", [TEXT_ONLY_RULE], "input", "text");
    expect(result.text).toBe(" data");
    expect(result.events).toHaveLength(1);
  });

  test("fires onSanitization callback", () => {
    const events: unknown[] = [];
    sanitizeString("badword", [STRIP_RULE], "input", undefined, (e) => events.push(e));
    expect(events).toHaveLength(1);
  });

  test("preserves location in events", () => {
    const result = sanitizeString("badword", [STRIP_RULE], "tool-output");
    expect(result.events[0]?.location).toBe("tool-output");
  });
});

describe("sanitizeBlock", () => {
  test("sanitizes text block", () => {
    const block: ContentBlock = { kind: "text", text: "hello badword" };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toEqual({ kind: "text", text: "hello [redacted]" });
    expect(result.blocked).toBe(false);
  });

  test("sanitizes file block name", () => {
    const block: ContentBlock = {
      kind: "file",
      url: "http://a.com",
      mimeType: "text/plain",
      name: "badword.txt",
    };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toEqual({
      kind: "file",
      url: "http://a.com",
      mimeType: "text/plain",
      name: "[redacted].txt",
    });
  });

  test("passes file block without name", () => {
    const block: ContentBlock = { kind: "file", url: "http://a.com", mimeType: "text/plain" };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toBe(block);
    expect(result.events).toHaveLength(0);
  });

  test("sanitizes image block alt text", () => {
    const block: ContentBlock = { kind: "image", url: "http://img.png", alt: "badword image" };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toEqual({ kind: "image", url: "http://img.png", alt: "[redacted] image" });
  });

  test("passes image block without alt", () => {
    const block: ContentBlock = { kind: "image", url: "http://img.png" };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toBe(block);
  });

  test("sanitizes button label and action", () => {
    const block: ContentBlock = {
      kind: "button",
      label: "click badword",
      action: "badword-action",
    };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toEqual({
      kind: "button",
      label: "click [redacted]",
      action: "[redacted]-action",
    });
    expect(result.events).toHaveLength(2);
  });

  test("passes custom block through unchanged", () => {
    const block: ContentBlock = { kind: "custom", type: "x", data: { badword: true } };
    const result = sanitizeBlock(block, [STRIP_RULE], "input");
    expect(result.block).toBe(block);
    expect(result.events).toHaveLength(0);
  });

  test("reports blocked on text block with block rule", () => {
    const block: ContentBlock = { kind: "text", text: "evil content" };
    const result = sanitizeBlock(block, [BLOCK_RULE], "input");
    expect(result.blocked).toBe(true);
  });
});

describe("sanitizeMessage", () => {
  const makeMessage = (blocks: readonly ContentBlock[]): InboundMessage => ({
    content: blocks,
    senderId: "user-1",
    timestamp: Date.now(),
  });

  test("sanitizes all blocks in a message", () => {
    const msg = makeMessage([
      { kind: "text", text: "hello badword" },
      { kind: "text", text: "another badword" },
    ]);
    const result = sanitizeMessage(msg, [STRIP_RULE], "input");
    expect(result.message.content[0]).toEqual({ kind: "text", text: "hello [redacted]" });
    expect(result.message.content[1]).toEqual({ kind: "text", text: "another [redacted]" });
    expect(result.events).toHaveLength(2);
  });

  test("preserves message metadata", () => {
    const msg = makeMessage([{ kind: "text", text: "clean" }]);
    const result = sanitizeMessage(msg, [STRIP_RULE], "input");
    expect(result.message.senderId).toBe("user-1");
    expect(result.message.content[0]).toEqual({ kind: "text", text: "clean" });
  });

  test("reports blocked if any block is blocked", () => {
    const msg = makeMessage([
      { kind: "text", text: "safe text" },
      { kind: "text", text: "evil text" },
    ]);
    const result = sanitizeMessage(msg, [BLOCK_RULE], "input");
    expect(result.blocked).toBe(true);
  });

  test("handles empty content array", () => {
    const msg = makeMessage([]);
    const result = sanitizeMessage(msg, [STRIP_RULE], "input");
    expect(result.message.content).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });

  test("returns new message object (immutability)", () => {
    const msg = makeMessage([{ kind: "text", text: "hello badword" }]);
    const result = sanitizeMessage(msg, [STRIP_RULE], "input");
    expect(result.message).not.toBe(msg);
  });
});

describe("sanitizeString — multi-occurrence replacement", () => {
  test("replaces all occurrences of a pattern in a single string", () => {
    const result = sanitizeString("badword foo badword bar badword", [STRIP_RULE], "input");
    expect(result.text).toBe("[redacted] foo [redacted] bar [redacted]");
    expect(result.blocked).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  test("replaces all occurrences across multiple rules", () => {
    const result = sanitizeString(
      "badword and suspicious and badword again suspicious",
      [STRIP_RULE, FLAG_RULE],
      "input",
    );
    expect(result.text).toBe("[redacted] and [flagged] and [redacted] again [flagged]");
    expect(result.events).toHaveLength(2);
  });

  test("block action fires on first occurrence without modifying text", () => {
    const input = "evil stuff and more evil stuff";
    const result = sanitizeString(input, [BLOCK_RULE], "input");
    expect(result.blocked).toBe(true);
    expect(result.text).toBe(input);
    expect(result.events).toHaveLength(1);
  });

  test("replaces all control characters, not just the first", () => {
    const controlCharRule: SanitizeRule = {
      name: "control-char-strip",
      pattern: /\0/,
      action: { kind: "strip", replacement: "" },
    };
    const result = sanitizeString("hello\0world\0test", [controlCharRule], "input");
    expect(result.text).toBe("helloworldtest");
  });

  test("custom block passthrough emits onSanitization callback", () => {
    const events: unknown[] = [];
    const block: ContentBlock = { kind: "custom", type: "x", data: { some: "data" } };
    sanitizeBlock(block, [STRIP_RULE], "input", (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect((events[0] as { rule: { name: string } }).rule.name).toBe("custom-block-passthrough");
  });
});
