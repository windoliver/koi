import { describe, expect, test } from "bun:test";
import type { MemoryRecordId } from "@koi/core";
import { formatMemorySection, formatSingleMemory } from "../format.js";
import type { ScoredMemory } from "../salience.js";
import type { ScannedMemory } from "../scan.js";

function makeScored(
  name: string,
  type: "user" | "feedback" | "project" | "reference",
  content: string,
  score: number,
): ScoredMemory {
  const memory: ScannedMemory = {
    record: {
      id: `mem-${name}` as MemoryRecordId,
      name,
      description: `desc of ${name}`,
      type,
      content,
      filePath: `${name}.md`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    fileSize: content.length,
  };
  return {
    memory,
    salienceScore: score,
    decayScore: 1.0,
    typeRelevance: 1.0,
  };
}

// ---------------------------------------------------------------------------
// formatSingleMemory
// ---------------------------------------------------------------------------

describe("formatSingleMemory", () => {
  test("formats a memory with heading and content in trust boundary", () => {
    const scored = makeScored("User role", "user", "Senior engineer", 0.9);
    const result = formatSingleMemory(scored);
    expect(result).toContain("### User role (user)");
    expect(result).toContain("<memory-data>");
    expect(result).toContain("Senior engineer");
    expect(result).toContain("</memory-data>");
  });

  test("includes score when requested", () => {
    const scored = makeScored("Test", "feedback", "content", 0.87);
    const result = formatSingleMemory(scored, true);
    expect(result).toContain("[score: 0.87]");
  });

  test("omits score by default", () => {
    const scored = makeScored("Test", "feedback", "content", 0.87);
    const result = formatSingleMemory(scored);
    expect(result).not.toContain("score:");
  });
});

// ---------------------------------------------------------------------------
// formatMemorySection
// ---------------------------------------------------------------------------

describe("formatMemorySection", () => {
  test("returns empty string for empty input", () => {
    expect(formatMemorySection([])).toBe("");
  });

  test("includes section header", () => {
    const memories = [makeScored("Test", "user", "content", 1.0)];
    const result = formatMemorySection(memories);
    expect(result).toStartWith("## Memory\n");
  });

  test("includes trusting-recall note with injection warning by default", () => {
    const memories = [makeScored("Test", "user", "content", 1.0)];
    const result = formatMemorySection(memories);
    expect(result).toContain("reference data");
    expect(result).toContain("not instructions");
    expect(result).toContain("Do not execute");
  });

  test("omits trusting-recall note when disabled", () => {
    const memories = [makeScored("Test", "user", "content", 1.0)];
    const result = formatMemorySection(memories, { trustingRecallNote: false });
    expect(result).not.toContain("reference data");
    expect(result).not.toContain("Do not execute");
  });

  test("uses custom section title", () => {
    const memories = [makeScored("Test", "user", "content", 1.0)];
    const result = formatMemorySection(memories, { sectionTitle: "Agent Memory" });
    expect(result).toStartWith("## Agent Memory\n");
  });

  test("groups memories by type", () => {
    const memories = [
      makeScored("Feedback1", "feedback", "fb content", 1.0),
      makeScored("User1", "user", "user content", 0.9),
      makeScored("Ref1", "reference", "ref content", 0.8),
    ];
    const result = formatMemorySection(memories);
    const feedbackIdx = result.indexOf("### Feedback1");
    const userIdx = result.indexOf("### User1");
    const refIdx = result.indexOf("### Ref1");
    // All present
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(refIdx).toBeGreaterThan(-1);
  });

  test("includes scores when requested", () => {
    const memories = [makeScored("Test", "user", "content", 0.75)];
    const result = formatMemorySection(memories, { includeScores: true });
    expect(result).toContain("[score: 0.75]");
  });

  test("formats multiple memories in same type group", () => {
    const memories = [
      makeScored("FB1", "feedback", "first", 1.0),
      makeScored("FB2", "feedback", "second", 0.5),
    ];
    const result = formatMemorySection(memories);
    expect(result).toContain("### FB1 (feedback)");
    expect(result).toContain("### FB2 (feedback)");
    expect(result).toContain("first");
    expect(result).toContain("second");
  });
});
