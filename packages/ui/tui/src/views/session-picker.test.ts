import { describe, expect, test } from "bun:test";
import { parseSessionMessages } from "./session-picker.js";

describe("parseSessionMessages", () => {
  test("returns empty array for empty content", () => {
    expect(parseSessionMessages("")).toEqual([]);
    expect(parseSessionMessages("   ")).toEqual([]);
  });

  test("parses JSON-lines with known message kinds", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hello", timestamp: 100 }),
      JSON.stringify({ kind: "assistant", text: "hi there", timestamp: 200 }),
      JSON.stringify({ kind: "lifecycle", event: "Run started", timestamp: 300 }),
    ].join("\n");

    const messages = parseSessionMessages(content);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.kind).toBe("user");
    expect(messages[1]?.kind).toBe("assistant");
    expect(messages[2]?.kind).toBe("lifecycle");
  });

  test("parses tool_call messages", () => {
    const content = JSON.stringify({
      kind: "tool_call",
      name: "search",
      args: '{"q":"test"}',
      result: "found it",
      timestamp: 400,
    });

    const messages = parseSessionMessages(content);
    expect(messages).toHaveLength(1);
    if (messages[0]?.kind === "tool_call") {
      expect(messages[0].name).toBe("search");
      expect(messages[0].result).toBe("found it");
    }
  });

  test("skips lines with unknown kind", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hi", timestamp: 1 }),
      JSON.stringify({ kind: "unknown_thing", data: "ignored" }),
      JSON.stringify({ kind: "assistant", text: "bye", timestamp: 2 }),
    ].join("\n");

    const messages = parseSessionMessages(content);
    expect(messages).toHaveLength(2);
  });

  test("skips malformed JSON lines", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hi", timestamp: 1 }),
      "not-json-at-all",
      JSON.stringify({ kind: "assistant", text: "bye", timestamp: 2 }),
    ].join("\n");

    const messages = parseSessionMessages(content);
    expect(messages).toHaveLength(2);
  });

  test("falls back to lifecycle event for non-JSON content", () => {
    const content = "Some plain text log output\nAnother line";

    const messages = parseSessionMessages(content);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("lifecycle");
    if (messages[0]?.kind === "lifecycle") {
      expect(messages[0].event).toContain("Some plain text");
    }
  });

  test("truncates long fallback content to 2000 chars", () => {
    const longContent = "x".repeat(3000);

    const messages = parseSessionMessages(longContent);
    expect(messages).toHaveLength(1);
    if (messages[0]?.kind === "lifecycle") {
      expect(messages[0].event.length).toBe(2000);
    }
  });
});
