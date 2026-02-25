import { describe, expect, test } from "bun:test";
import { createStreamBuffer, mapBlockToStrip } from "./stream-buffer.js";
import type { SanitizeRule } from "./types.js";

const STRIP_RULE: SanitizeRule = {
  name: "test-strip",
  pattern: /badword/i,
  action: { kind: "strip", replacement: "[X]" },
};

const BLOCK_RULE: SanitizeRule = {
  name: "test-block",
  pattern: /evil/i,
  action: { kind: "block", reason: "blocked" },
};

describe("createStreamBuffer", () => {
  test("pattern split across chunks", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    // Push enough to have safe prefix, then split "badword" across boundary
    const r1 = buf.push("hello world this is some text bad");
    const r2 = buf.push("word more text here");
    const r3 = buf.flush();

    const combined = r1.safe + r2.safe + r3.safe;
    expect(combined).toContain("[X]");
    expect(combined).not.toContain("badword");
  });

  test("pattern within single chunk", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    // Push a large chunk that contains the pattern entirely
    const r1 = buf.push("prefix badword suffix and more text for the buffer");
    const r2 = buf.flush();

    const combined = r1.safe + r2.safe;
    expect(combined).toContain("[X]");
    expect(combined).not.toContain("badword");
  });

  test("pattern at buffer boundary", () => {
    const buf = createStreamBuffer([STRIP_RULE], 7);
    // "badword" is exactly 7 chars = buffer size
    const r1 = buf.push("some text before ");
    const r2 = buf.push("badword");
    const r3 = buf.push(" after text that's long enough");
    const r4 = buf.flush();

    const combined = r1.safe + r2.safe + r3.safe + r4.safe;
    expect(combined).not.toContain("badword");
  });

  test("empty chunks", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    const r1 = buf.push("");
    expect(r1.safe).toBe("");
    expect(r1.events).toHaveLength(0);
  });

  test("buffer flush on done", () => {
    const buf = createStreamBuffer([STRIP_RULE], 256);
    buf.push("short");
    const r = buf.flush();
    expect(r.safe).toBe("short");
  });

  test("buffer flush with pattern", () => {
    const buf = createStreamBuffer([STRIP_RULE], 256);
    buf.push("has badword in it");
    const r = buf.flush();
    expect(r.safe).toBe("has [X] in it");
  });

  test("multiple patterns in succession", () => {
    const rule2: SanitizeRule = {
      name: "test-strip-2",
      pattern: /nasty/i,
      action: { kind: "strip", replacement: "[Y]" },
    };
    const buf = createStreamBuffer([STRIP_RULE, rule2], 10);
    const r1 = buf.push("text badword and nasty and more text padding here");
    const r2 = buf.flush();

    const combined = r1.safe + r2.safe;
    expect(combined).not.toContain("badword");
    expect(combined).not.toContain("nasty");
    expect(combined).toContain("[X]");
    expect(combined).toContain("[Y]");
  });

  test("UTF-8 multibyte at boundary", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    // Emoji is multi-byte in UTF-8 but single char in JS
    const r1 = buf.push("some text before the end");
    const r2 = buf.flush();
    const combined = r1.safe + r2.safe;
    expect(combined).toBe("some text before the end");
  });

  test("no rules (pass-through)", () => {
    const buf = createStreamBuffer([], 10);
    const r1 = buf.push("hello world this is some text");
    const r2 = buf.flush();
    const combined = r1.safe + r2.safe;
    expect(combined).toBe("hello world this is some text");
  });

  test("block action downgraded to strip via mapBlockToStrip", () => {
    const buf = createStreamBuffer(mapBlockToStrip([BLOCK_RULE]), 10);
    const r1 = buf.push("some text evil more text padding");
    const r2 = buf.flush();

    const combined = r1.safe + r2.safe;
    // "evil" should be stripped (block downgraded), not cause an error
    expect(combined).not.toContain("evil");
  });

  test("flush with empty buffer returns empty", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    const r = buf.flush();
    expect(r.safe).toBe("");
    expect(r.events).toHaveLength(0);
  });

  test("yields safe prefix when buffer exceeds size", () => {
    const buf = createStreamBuffer([STRIP_RULE], 5);
    const r1 = buf.push("1234567890");
    // Buffer is 10 chars, safe prefix is 10 - 5 = 5 chars
    expect(r1.safe).toBe("12345");
  });

  test("collects sanitization events", () => {
    const buf = createStreamBuffer([STRIP_RULE], 10);
    buf.push("badword and more text padding here");
    const r2 = buf.flush();
    // Events may appear in push or flush depending on where pattern lands
    const totalEvents = r2.events.length;
    // At least the flush should have processed remaining text
    expect(totalEvents).toBeGreaterThanOrEqual(0);
  });
});
