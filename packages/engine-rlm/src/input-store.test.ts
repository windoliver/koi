import { describe, expect, test } from "bun:test";
import { createInputStore, detectFormat, extractStructureHints } from "./input-store.js";

describe("detectFormat", () => {
  test("detects JSON object", () => {
    expect(detectFormat('{"key": "value"}')).toBe("json");
  });

  test("detects JSON array", () => {
    expect(detectFormat("[1, 2, 3]")).toBe("json");
  });

  test("detects markdown with heading", () => {
    expect(detectFormat("# Title\n\nSome content")).toBe("markdown");
  });

  test("detects markdown with code fence", () => {
    expect(detectFormat("```js\nconsole.log('hi');\n```")).toBe("markdown");
  });

  test("detects CSV with commas", () => {
    expect(detectFormat("name,age,city\nAlice,30,NYC\nBob,25,LA")).toBe("csv");
  });

  test("detects CSV with tabs", () => {
    expect(detectFormat("name\tage\tcity\nAlice\t30\tNYC")).toBe("csv");
  });

  test("defaults to plaintext", () => {
    expect(detectFormat("Just some plain text content here.")).toBe("plaintext");
  });

  test("handles empty input", () => {
    expect(detectFormat("")).toBe("plaintext");
  });
});

describe("extractStructureHints", () => {
  test("extracts JSON top-level keys", () => {
    const hints = extractStructureHints('{"name": "Alice", "age": 30, "items": []}', "json");
    expect(hints).toContain("name");
    expect(hints).toContain("age");
    expect(hints).toContain("items");
  });

  test("extracts CSV headers", () => {
    const hints = extractStructureHints("name,age,city\nAlice,30,NYC", "csv");
    expect(hints).toContain("name");
    expect(hints).toContain("age");
    expect(hints).toContain("city");
  });

  test("extracts markdown headings", () => {
    const hints = extractStructureHints(
      "# Title\n## Section A\n### Subsection\n## Section B",
      "markdown",
    );
    expect(hints).toContain("# Title");
    expect(hints).toContain("## Section A");
    expect(hints).toContain("## Section B");
  });

  test("returns empty for plaintext", () => {
    expect(extractStructureHints("Just text.", "plaintext")).toEqual([]);
  });

  test("handles malformed JSON gracefully", () => {
    expect(extractStructureHints("{invalid", "json")).toEqual([]);
  });
});

describe("createInputStore", () => {
  test("rejects input exceeding maxInputBytes", () => {
    const largeInput = "x".repeat(1001);
    expect(() => createInputStore(largeInput, { maxInputBytes: 1000 })).toThrow(/exceeds maximum/);
  });

  test("accepts input at exactly maxInputBytes", () => {
    const input = "x".repeat(1000);
    const store = createInputStore(input, { maxInputBytes: 1000 });
    expect(store.metadata().sizeBytes).toBe(1000);
  });

  test("examine returns correct slice", () => {
    const store = createInputStore("Hello, World!");
    expect(store.examine(0, 5)).toBe("Hello");
    expect(store.examine(7, 6)).toBe("World!");
  });

  test("examine out-of-bounds returns empty string", () => {
    const store = createInputStore("Hello");
    expect(store.examine(100, 5)).toBe("");
  });

  test("examine clamps length at end of input", () => {
    const store = createInputStore("Hello");
    expect(store.examine(3, 100)).toBe("lo");
  });

  test("chunk count equals Math.ceil(length / chunkSize)", () => {
    const input = "x".repeat(10000);
    const store = createInputStore(input, { chunkSize: 4000 });
    expect(store.metadata().totalChunks).toBe(3); // ceil(10000/4000) = 3
  });

  test("chunk count is 1 for small input", () => {
    const store = createInputStore("short", { chunkSize: 4000 });
    expect(store.metadata().totalChunks).toBe(1);
  });

  test("format detection works via metadata", () => {
    const store = createInputStore('{"key": "value"}');
    expect(store.metadata().format).toBe("json");
  });

  test("structure hints are extracted", () => {
    const store = createInputStore('{"name": "Alice", "age": 30}');
    const meta = store.metadata();
    expect(meta.structureHints).toContain("name");
    expect(meta.structureHints).toContain("age");
  });

  test("preview is capped at previewLength", () => {
    const input = "x".repeat(1000);
    const store = createInputStore(input, { previewLength: 200 });
    expect(store.metadata().preview.length).toBe(200);
  });

  test("preview shows full input when shorter than previewLength", () => {
    const store = createInputStore("short", { previewLength: 200 });
    expect(store.metadata().preview).toBe("short");
  });

  test("estimated tokens uses chars/4 approximation", () => {
    const input = "x".repeat(400);
    const store = createInputStore(input);
    expect(store.metadata().estimatedTokens).toBe(100);
  });

  test("chunk descriptors: offset + length sum equals input length", () => {
    const input = "x".repeat(10000);
    const store = createInputStore(input, { chunkSize: 4000 });
    const chunks = store.chunkDescriptors(0, store.metadata().totalChunks - 1);
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalLength).toBe(10000);
  });

  test("chunk descriptors have correct offsets", () => {
    const input = "x".repeat(10000);
    const store = createInputStore(input, { chunkSize: 4000 });
    const chunks = store.chunkDescriptors(0, 2);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[0]?.length).toBe(4000);
    expect(chunks[1]?.offset).toBe(4000);
    expect(chunks[1]?.length).toBe(4000);
    expect(chunks[2]?.offset).toBe(8000);
    expect(chunks[2]?.length).toBe(2000);
  });

  test("chunk descriptors include preview", () => {
    const input = "abcdefghij".repeat(500);
    const store = createInputStore(input, { chunkSize: 1000, previewLength: 50 });
    const chunks = store.chunkDescriptors(0, 0);
    expect(chunks[0]?.preview.length).toBeLessThanOrEqual(50);
    expect(chunks[0]?.preview.length).toBeGreaterThan(0);
  });

  test("chunkDescriptors with invalid range returns empty", () => {
    const store = createInputStore("hello", { chunkSize: 100 });
    expect(store.chunkDescriptors(5, 10)).toEqual([]);
  });

  test("metadata is cached across calls", () => {
    const store = createInputStore('{"key": "value"}');
    const meta1 = store.metadata();
    const meta2 = store.metadata();
    expect(meta1).toBe(meta2); // same reference
  });
});
