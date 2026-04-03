/**
 * Tests for shared CLI helpers.
 */

import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@koi/core";
import { extractTextFromBlocks } from "./helpers.js";

describe("extractTextFromBlocks", () => {
  test("extracts text from text blocks", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "text", text: "world" },
    ];
    expect(extractTextFromBlocks(blocks)).toBe("hello\nworld");
  });

  test("filters out non-text blocks", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "image", url: "https://example.com/img.png" },
      { kind: "text", text: "world" },
    ];
    expect(extractTextFromBlocks(blocks)).toBe("hello\nworld");
  });

  test("returns empty string for empty array", () => {
    expect(extractTextFromBlocks([])).toBe("");
  });

  test("returns empty string when no text blocks present", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "image", url: "https://example.com/img.png" }];
    expect(extractTextFromBlocks(blocks)).toBe("");
  });

  test("returns single text without newline for one block", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "text", text: "only one" }];
    expect(extractTextFromBlocks(blocks)).toBe("only one");
  });
});
