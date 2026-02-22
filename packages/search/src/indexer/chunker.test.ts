import { describe, expect, test } from "bun:test";
import { chunk } from "./chunker.js";

describe("chunker", () => {
  test("returns empty array for empty text", () => {
    expect(chunk("")).toEqual([]);
  });

  test("returns single chunk for short text", () => {
    const result = chunk("hello world");
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("hello world");
    expect(result[0]?.index).toBe(0);
    expect(result[0]?.startOffset).toBe(0);
    expect(result[0]?.endOffset).toBe(11);
  });

  test("splits on paragraph boundary", () => {
    const text = `${"A".repeat(100)}\n\n${"B".repeat(100)}`;
    const result = chunk(text, { chunkSize: 150, chunkOverlap: 0 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]?.text).toBe("A".repeat(100));
  });

  test("splits on newline when no paragraph boundary", () => {
    const text = `${"A".repeat(100)}\n${"B".repeat(100)}`;
    const result = chunk(text, { chunkSize: 150, chunkOverlap: 0 });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("splits on sentence boundary", () => {
    const text = `${"A".repeat(100)}. ${"B".repeat(100)}`;
    const result = chunk(text, { chunkSize: 150, chunkOverlap: 0 });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("splits on word boundary as last resort before char split", () => {
    // Words of 10 chars each, with spaces
    const words = Array.from({ length: 20 }, () => "abcdefghij").join(" ");
    const result = chunk(words, { chunkSize: 50, chunkOverlap: 0 });
    expect(result.length).toBeGreaterThan(1);
  });

  test("handles very long text without separators", () => {
    const text = "X".repeat(500);
    const result = chunk(text, { chunkSize: 100, chunkOverlap: 0 });
    expect(result.length).toBe(5);
    for (const c of result) {
      expect(c.text.length).toBeLessThanOrEqual(100);
    }
  });

  test("applies overlap between chunks", () => {
    const text = `${"A".repeat(200)}\n\n${"B".repeat(200)}`;
    const result = chunk(text, { chunkSize: 250, chunkOverlap: 50 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Second chunk should start with overlap from first
    if (result.length >= 2) {
      expect(result[1]?.text.length).toBeGreaterThan(200);
    }
  });

  test("chunk indices are sequential", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}`).join("\n\n");
    const result = chunk(text, { chunkSize: 30, chunkOverlap: 0 });
    for (let i = 0; i < result.length; i++) {
      expect(result[i]?.index).toBe(i);
    }
  });

  test("uses default config when none provided", () => {
    const text = "short";
    const result = chunk(text);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("short");
  });
});
