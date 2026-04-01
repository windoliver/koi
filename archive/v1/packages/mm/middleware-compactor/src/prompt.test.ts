import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type { CapabilityFragment } from "@koi/core/middleware";
import { buildSummaryPrompt, formatConventionBlock } from "./prompt.js";

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

function assistantMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "assistant", timestamp: 2 };
}

function toolMsg(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: 3,
    metadata: { callId: "c1" },
  };
}

describe("buildSummaryPrompt", () => {
  test("includes all message roles in output", () => {
    const msgs = [userMsg("hello"), assistantMsg("hi"), toolMsg("result")];
    const prompt = buildSummaryPrompt(msgs, 500);
    expect(prompt).toContain("[user]");
    expect(prompt).toContain("[assistant]");
    expect(prompt).toContain("[tool]");
  });

  test("includes message content", () => {
    const msgs = [userMsg("deploy the app")];
    const prompt = buildSummaryPrompt(msgs, 500);
    expect(prompt).toContain("deploy the app");
  });

  test("truncates long messages", () => {
    const longText = "x".repeat(3000);
    const msgs = [userMsg(longText)];
    const prompt = buildSummaryPrompt(msgs, 500);
    // Should be truncated — won't contain the full 3000 chars
    expect(prompt.length).toBeLessThan(longText.length);
    expect(prompt).toContain("...[truncated]");
  });

  test("includes structured output sections", () => {
    const msgs = [userMsg("test")];
    const prompt = buildSummaryPrompt(msgs, 500);
    expect(prompt).toContain("SESSION INTENT");
    expect(prompt).toContain("SUMMARY");
    expect(prompt).toContain("ARTIFACTS");
    expect(prompt).toContain("NEXT STEPS");
  });

  test("includes max token instruction", () => {
    const msgs = [userMsg("test")];
    const prompt = buildSummaryPrompt(msgs, 750);
    expect(prompt).toContain("750");
  });

  test("handles empty messages array", () => {
    const prompt = buildSummaryPrompt([], 500);
    expect(prompt).toContain("SESSION INTENT");
    // Should still produce valid prompt structure
    expect(typeof prompt).toBe("string");
  });

  test("handles multi-block messages", () => {
    const msg: InboundMessage = {
      content: [
        { kind: "text", text: "first block" },
        { kind: "text", text: "second block" },
      ],
      senderId: "user",
      timestamp: 1,
    };
    const prompt = buildSummaryPrompt([msg], 500);
    expect(prompt).toContain("first block");
    expect(prompt).toContain("second block");
  });

  test("includes CONVENTIONS section when conventions provided", () => {
    const conventions: readonly CapabilityFragment[] = [
      { label: "immutability", description: "Never mutate shared state" },
      { label: "esm-only", description: "Use .js extensions in imports" },
    ];
    const prompt = buildSummaryPrompt([userMsg("test")], 500, conventions);
    expect(prompt).toContain("## CONVENTIONS (preserve verbatim)");
    expect(prompt).toContain("**immutability**");
    expect(prompt).toContain("Never mutate shared state");
    expect(prompt).toContain("**esm-only**");
  });

  test("omits CONVENTIONS section when conventions empty", () => {
    const prompt = buildSummaryPrompt([userMsg("test")], 500, []);
    expect(prompt).not.toContain("CONVENTIONS");
  });

  test("omits CONVENTIONS section when conventions undefined", () => {
    const prompt = buildSummaryPrompt([userMsg("test")], 500);
    expect(prompt).not.toContain("CONVENTIONS");
  });
});

describe("formatConventionBlock", () => {
  test("formats conventions into labeled block", () => {
    const conventions: readonly CapabilityFragment[] = [
      { label: "immutability", description: "No mutation" },
    ];
    const block = formatConventionBlock(conventions);
    expect(block).toBe("[Conventions]\n- **immutability**: No mutation");
  });

  test("returns empty string for empty array", () => {
    expect(formatConventionBlock([])).toBe("");
  });

  test("formats multiple conventions", () => {
    const conventions: readonly CapabilityFragment[] = [
      { label: "a", description: "desc-a" },
      { label: "b", description: "desc-b" },
    ];
    const block = formatConventionBlock(conventions);
    expect(block).toContain("- **a**: desc-a");
    expect(block).toContain("- **b**: desc-b");
  });
});
