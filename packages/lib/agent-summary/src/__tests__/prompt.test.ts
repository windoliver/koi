import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@koi/core";
import { transcriptEntryId } from "@koi/core";
import { buildPrompt, PROMPT_VERSION } from "../prompt.js";

const entry = (role: TranscriptEntry["role"], content = "x"): TranscriptEntry => ({
  id: transcriptEntryId("e"),
  role,
  content,
  timestamp: 0,
});

const baseFocus = {
  goals: true,
  tool_calls: true,
  errors: true,
  files_changed: true,
  decisions: true,
} as const;

describe("PROMPT_VERSION", () => {
  test("is a positive integer", () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
  });
});

describe("buildPrompt", () => {
  const entries = [entry("user", "hi"), entry("assistant", "hello")];

  test("high granularity prompt is terse", () => {
    const { system, user } = buildPrompt(entries, {
      granularity: "high",
      focus: baseFocus,
      maxTokens: 300,
      hasCompactionPrefix: false,
    });
    expect(system).toContain("top 3 outcomes");
    expect(user).toContain("hi");
  });

  test("detailed granularity prompt is thorough", () => {
    const { system } = buildPrompt(entries, {
      granularity: "detailed",
      focus: baseFocus,
      maxTokens: 4000,
      hasCompactionPrefix: false,
    });
    expect(system).toContain("every tool call");
  });

  test("medium granularity is neither extreme", () => {
    const { system } = buildPrompt(entries, {
      granularity: "medium",
      focus: baseFocus,
      maxTokens: 1200,
      hasCompactionPrefix: false,
    });
    expect(system).toContain("major actions");
  });

  test("hasCompactionPrefix adds the §6.4 derived-narrative sentence", () => {
    const { system } = buildPrompt(entries, {
      granularity: "medium",
      focus: baseFocus,
      maxTokens: 1200,
      hasCompactionPrefix: true,
    });
    expect(system).toContain("derived narrative");
  });

  test("enforces JSON-only output", () => {
    const { system } = buildPrompt(entries, {
      granularity: "medium",
      focus: baseFocus,
      maxTokens: 1200,
      hasCompactionPrefix: false,
    });
    expect(system.toLowerCase()).toContain("json");
  });

  test("focus flags gate prompt sections", () => {
    const { system } = buildPrompt(entries, {
      granularity: "medium",
      focus: { ...baseFocus, tool_calls: false },
      maxTokens: 1200,
      hasCompactionPrefix: false,
    });
    expect(system.toLowerCase()).not.toContain("tool_calls");
  });

  test("strict retry prompt is produced on retry path", () => {
    const { system } = buildPrompt(entries, {
      granularity: "medium",
      focus: baseFocus,
      maxTokens: 1200,
      hasCompactionPrefix: false,
      strictRetry: true,
    });
    expect(system.toLowerCase()).toContain("json only");
    expect(system).not.toContain("<analysis>");
  });
});
