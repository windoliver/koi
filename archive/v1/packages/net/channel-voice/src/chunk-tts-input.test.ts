/**
 * Unit tests for chunkTtsInput().
 */

import { describe, expect, test } from "bun:test";
import { chunkTtsInput } from "./chunk-tts-input.js";

// ---------------------------------------------------------------------------
// Empty / whitespace input
// ---------------------------------------------------------------------------

describe("chunkTtsInput — empty input", () => {
  test("returns empty array for empty string", () => {
    expect(chunkTtsInput("")).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(chunkTtsInput("   \n\n  \t  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Single sentence
// ---------------------------------------------------------------------------

describe("chunkTtsInput — single sentence", () => {
  test("returns single chunk for short single sentence", () => {
    expect(chunkTtsInput("Hello world.")).toEqual(["Hello world."]);
  });

  test("returns single chunk when text is under all thresholds", () => {
    const text = "This is a short sentence that fits easily.";
    expect(chunkTtsInput(text)).toEqual([text]);
  });
});

// ---------------------------------------------------------------------------
// Multiple sentences
// ---------------------------------------------------------------------------

describe("chunkTtsInput — multiple sentences", () => {
  test("splits multiple sentences into separate chunks", () => {
    const text = "First sentence is here. Second sentence follows. Third one too.";
    const chunks = chunkTtsInput(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be a non-empty string
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  test("merges short sentences below minChunkWords", () => {
    // "Hi." and "Ok." are each 1 word, below default minChunkWords of 3
    const text = "Hi. Ok. This is a longer sentence.";
    const chunks = chunkTtsInput(text);
    // "Hi." and "Ok." should be merged together
    expect(chunks[0]).toContain("Hi.");
    expect(chunks[0]).toContain("Ok.");
  });

  test("respects custom minChunkWords", () => {
    const text = "Hello world. Goodbye world. Another sentence here.";
    const chunks = chunkTtsInput(text, { minChunkWords: 1 });
    // With minChunkWords=1, each sentence can stand alone
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Long sentence splitting
// ---------------------------------------------------------------------------

describe("chunkTtsInput — long sentences", () => {
  test("splits long sentence at clause boundary when exceeding maxChunkChars", () => {
    // Build a sentence with a clause boundary that exceeds 50 chars
    const text =
      "This is the first part of a long sentence, and this is the second part that continues on.";
    const chunks = chunkTtsInput(text, { maxChunkChars: 50, minChunkWords: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100); // allow some leeway for recursive splits
    }
  });

  test("splits long sentence at word boundary when no clause boundary", () => {
    // A very long sentence with no clause boundaries
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const text = `${words.join(" ")}.`;
    const chunks = chunkTtsInput(text, { maxChunkChars: 80, minChunkWords: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should not exceed maxChunkChars
    const firstChunk = chunks[0];
    expect(firstChunk).toBeDefined();
    expect(firstChunk?.length).toBeLessThanOrEqual(80);
  });

  test("respects custom maxChunkChars", () => {
    const text = "Short. Another short one. Yet another. And more text here.";
    const chunks = chunkTtsInput(text, { maxChunkChars: 500 });
    // All text fits in one chunk at 500 chars
    expect(chunks.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Newlines
// ---------------------------------------------------------------------------

describe("chunkTtsInput — newlines", () => {
  test("handles newlines as hard breaks", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const chunks = chunkTtsInput(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Both paragraphs should appear in the output
    const joined = chunks.join(" ");
    expect(joined).toContain("First paragraph.");
    expect(joined).toContain("Second paragraph.");
  });

  test("treats single newline as break", () => {
    const text = "Line one sentence.\nLine two sentence.";
    const chunks = chunkTtsInput(text);
    const joined = chunks.join(" ");
    expect(joined).toContain("Line one sentence.");
    expect(joined).toContain("Line two sentence.");
  });
});

// ---------------------------------------------------------------------------
// CJK text
// ---------------------------------------------------------------------------

describe("chunkTtsInput — CJK text", () => {
  test("handles CJK punctuation", () => {
    const text =
      "\u3053\u308C\u306F\u6700\u521D\u306E\u6587\u3067\u3059\u3002\u3053\u308C\u306F\u4E8C\u756A\u76EE\u306E\u6587\u3067\u3059\u3002\u4E09\u756A\u76EE\u3082\u3042\u308A\u307E\u3059\u3002";
    const chunks = chunkTtsInput(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All original text should be preserved
    const joined = chunks.join(" ");
    expect(joined).toContain("\u3053\u308C\u306F\u6700\u521D\u306E\u6587\u3067\u3059\u3002");
  });

  test("handles mixed Latin and CJK text", () => {
    const text = "Hello world. \u3053\u3093\u306B\u3061\u306F\u3002 Goodbye.";
    const chunks = chunkTtsInput(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.join(" ");
    expect(joined).toContain("Hello world.");
    expect(joined).toContain("\u3053\u3093\u306B\u3061\u306F\u3002");
  });
});

// ---------------------------------------------------------------------------
// Whitespace and edge cases
// ---------------------------------------------------------------------------

describe("chunkTtsInput — edge cases", () => {
  test("trims whitespace from chunks", () => {
    const text = "  Hello world.   Goodbye world.  ";
    const chunks = chunkTtsInput(text);
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trim());
    }
  });

  test("handles ellipsis", () => {
    const text = "Well... that was interesting. Let me think about it.";
    const chunks = chunkTtsInput(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.join(" ");
    expect(joined).toContain("Well...");
  });

  test("handles single word", () => {
    const result = chunkTtsInput("Hello");
    expect(result).toEqual(["Hello"]);
  });

  test("handles text that is only punctuation", () => {
    // Intl.Segmenter treats punctuation as a segment, should produce non-empty output
    const result = chunkTtsInput("...");
    // Either empty or contains the punctuation
    if (result.length > 0) {
      expect(result[0]).toBe("...");
    }
  });
});
