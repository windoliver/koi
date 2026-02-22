import { describe, expect, test } from "bun:test";
import { resolveTextSource } from "./text.js";

describe("resolveTextSource", () => {
  test("returns text content directly", async () => {
    const result = await resolveTextSource({
      kind: "text",
      text: "Hello world",
    });
    expect(result.content).toBe("Hello world");
    expect(result.label).toBe("Text");
    expect(result.tokens).toBe(0); // Caller estimates
  });

  test("uses custom label when provided", async () => {
    const result = await resolveTextSource({
      kind: "text",
      text: "test",
      label: "Custom Label",
    });
    expect(result.label).toBe("Custom Label");
  });

  test("preserves source reference", async () => {
    const source = { kind: "text" as const, text: "test", priority: 5 };
    const result = await resolveTextSource(source);
    expect(result.source).toBe(source);
  });

  test("handles empty text", async () => {
    const result = await resolveTextSource({ kind: "text", text: "" });
    expect(result.content).toBe("");
  });

  test("handles multiline text", async () => {
    const text = "line 1\nline 2\nline 3";
    const result = await resolveTextSource({ kind: "text", text });
    expect(result.content).toBe(text);
  });
});
