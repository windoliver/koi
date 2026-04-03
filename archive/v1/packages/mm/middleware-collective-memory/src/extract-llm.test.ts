import { describe, expect, test } from "bun:test";
import { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";

// ---------------------------------------------------------------------------
// createExtractionPrompt
// ---------------------------------------------------------------------------

describe("createExtractionPrompt", () => {
  test("includes all outputs separated by delimiter", () => {
    const prompt = createExtractionPrompt(["output 1", "output 2", "output 3"]);
    expect(prompt).toContain("output 1");
    expect(prompt).toContain("output 2");
    expect(prompt).toContain("output 3");
    expect(prompt).toContain("---");
  });

  test("includes category instructions", () => {
    const prompt = createExtractionPrompt(["some output"]);
    expect(prompt).toContain("gotcha");
    expect(prompt).toContain("heuristic");
    expect(prompt).toContain("preference");
    expect(prompt).toContain("correction");
    expect(prompt).toContain("pattern");
    expect(prompt).toContain("context");
  });

  test("handles empty outputs array", () => {
    const prompt = createExtractionPrompt([]);
    expect(prompt).toContain("Worker outputs:");
    // Should still produce a valid prompt, just with no content
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("handles single output", () => {
    const prompt = createExtractionPrompt(["single output"]);
    expect(prompt).toContain("single output");
    // No delimiter needed for single output
    expect(prompt).not.toContain("---");
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse
// ---------------------------------------------------------------------------

describe("parseExtractionResponse", () => {
  test("parses valid JSON array", () => {
    const response = JSON.stringify([
      { content: "Always validate inputs", category: "gotcha" },
      { content: "Use exponential backoff", category: "pattern" },
    ]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("Always validate inputs");
    expect(result[0]?.category).toBe("gotcha");
    expect(result[0]?.confidence).toBe(0.9);
    expect(result[1]?.content).toBe("Use exponential backoff");
    expect(result[1]?.category).toBe("pattern");
  });

  test("returns empty on malformed JSON", () => {
    const result = parseExtractionResponse("this is not json");
    expect(result).toHaveLength(0);
  });

  test("returns empty on non-array JSON", () => {
    const result = parseExtractionResponse('{"content": "test"}');
    expect(result).toHaveLength(0);
  });

  test("filters entries with empty content", () => {
    const response = JSON.stringify([
      { content: "", category: "gotcha" },
      { content: "  ", category: "heuristic" },
      { content: "Valid learning", category: "pattern" },
    ]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Valid learning");
  });

  test("defaults invalid categories to context", () => {
    const response = JSON.stringify([
      { content: "Learning with bad category", category: "invalid_cat" },
    ]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("context");
  });

  test("handles all valid categories", () => {
    const categories = [
      "gotcha",
      "heuristic",
      "preference",
      "correction",
      "pattern",
      "context",
    ] as const;
    const entries = categories.map((c) => ({ content: `learning for ${c}`, category: c }));
    const result = parseExtractionResponse(JSON.stringify(entries));
    expect(result).toHaveLength(6);
    for (const [i, cat] of categories.entries()) {
      expect(result[i]?.category).toBe(cat);
    }
  });

  test("truncates long content", () => {
    const longContent = "x".repeat(600);
    const response = JSON.stringify([{ content: longContent, category: "gotcha" }]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]?.content.length).toBe(500);
  });

  test("handles markdown-fenced JSON response", () => {
    const json = JSON.stringify([{ content: "Fenced learning", category: "heuristic" }]);
    const fenced = `\`\`\`json\n${json}\n\`\`\``;
    const result = parseExtractionResponse(fenced);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Fenced learning");
  });

  test("handles markdown-fenced without language tag", () => {
    const json = JSON.stringify([{ content: "No lang tag", category: "pattern" }]);
    const fenced = `\`\`\`\n${json}\n\`\`\``;
    const result = parseExtractionResponse(fenced);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("No lang tag");
  });

  test("handles surrounding text around JSON array", () => {
    const json = JSON.stringify([{ content: "Surrounded learning", category: "gotcha" }]);
    const withText = `Here are the learnings:\n${json}\nHope this helps!`;
    const result = parseExtractionResponse(withText);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Surrounded learning");
  });

  test("skips null entries in array", () => {
    const response = JSON.stringify([null, { content: "Valid", category: "gotcha" }, 42, "string"]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Valid");
  });

  test("handles missing category field", () => {
    const response = JSON.stringify([{ content: "No category" }]);
    const result = parseExtractionResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("context");
  });

  test("returns empty array for empty JSON array", () => {
    const result = parseExtractionResponse("[]");
    expect(result).toHaveLength(0);
  });

  test("trims whitespace from content", () => {
    const response = JSON.stringify([{ content: "  trimmed content  ", category: "gotcha" }]);
    const result = parseExtractionResponse(response);
    expect(result[0]?.content).toBe("trimmed content");
  });
});
