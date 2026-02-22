import { describe, expect, test } from "bun:test";
import { validateContextConfig } from "./config.js";

describe("validateContextConfig", () => {
  test("validates a valid config with all source kinds", () => {
    const raw = {
      maxTokens: 4000,
      sources: [
        { kind: "text", text: "Hello", label: "Greeting", required: true, priority: 0 },
        { kind: "file", path: "./docs/readme.md", priority: 10 },
        { kind: "memory", query: "user prefs", priority: 20 },
        { kind: "skill", name: "research", priority: 30 },
        { kind: "tool_schema", tools: ["search", "read"], priority: 50 },
      ],
    };

    const result = validateContextConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxTokens).toBe(4000);
      expect(result.value.sources).toHaveLength(5);
      expect(result.value.sources[0]?.kind).toBe("text");
    }
  });

  test("validates minimal config with one source", () => {
    const result = validateContextConfig({
      sources: [{ kind: "text", text: "hi" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxTokens).toBeUndefined();
      expect(result.value.sources).toHaveLength(1);
    }
  });

  test("rejects empty sources array", () => {
    const result = validateContextConfig({ sources: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects missing sources field", () => {
    const result = validateContextConfig({});
    expect(result.ok).toBe(false);
  });

  test("rejects invalid source kind", () => {
    const result = validateContextConfig({
      sources: [{ kind: "invalid", text: "hi" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxTokens", () => {
    const result = validateContextConfig({
      maxTokens: -1,
      sources: [{ kind: "text", text: "hi" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero maxTokens", () => {
    const result = validateContextConfig({
      maxTokens: 0,
      sources: [{ kind: "text", text: "hi" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects text source without text field", () => {
    const result = validateContextConfig({
      sources: [{ kind: "text" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects file source without path field", () => {
    const result = validateContextConfig({
      sources: [{ kind: "file" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects memory source without query field", () => {
    const result = validateContextConfig({
      sources: [{ kind: "memory" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects skill source without name field", () => {
    const result = validateContextConfig({
      sources: [{ kind: "skill" }],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts tool_schema without tools field (discovers all)", () => {
    const result = validateContextConfig({
      sources: [{ kind: "tool_schema" }],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts all optional fields on sources", () => {
    const result = validateContextConfig({
      sources: [
        {
          kind: "text",
          text: "test",
          label: "Test Label",
          required: true,
          priority: 42,
          maxTokens: 500,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const source = result.value.sources[0];
      if (source === undefined) throw new Error("Expected source");
      expect(source.label).toBe("Test Label");
      expect(source.required).toBe(true);
      expect(source.priority).toBe(42);
      expect(source.maxTokens).toBe(500);
    }
  });

  test("rejects non-object input", () => {
    expect(validateContextConfig("not an object").ok).toBe(false);
    expect(validateContextConfig(42).ok).toBe(false);
    expect(validateContextConfig(null).ok).toBe(false);
  });
});
