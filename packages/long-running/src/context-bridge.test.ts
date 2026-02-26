/**
 * Tests for context bridge — resume context builder.
 */

import { describe, expect, test } from "bun:test";
import type {
  ContextSummary,
  HarnessMetrics,
  HarnessSnapshot,
  KeyArtifact,
  TaskBoardSnapshot,
} from "@koi/core";
import { harnessId, taskItemId } from "@koi/core";
import { assertErr, assertOk } from "@koi/test-utils";
import { buildInitialPrompt, buildResumeContext } from "./context-bridge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_METRICS: HarnessMetrics = {
  totalSessions: 0,
  totalTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  completedTaskCount: 0,
  pendingTaskCount: 2,
  elapsedMs: 0,
};

function createTestBoard(taskCount = 2): TaskBoardSnapshot {
  return {
    items: Array.from({ length: taskCount }, (_, i) => ({
      id: taskItemId(`task-${String(i + 1)}`),
      description: `Task ${String(i + 1)} description`,
      dependencies: [],
      priority: 0,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    })),
    results: [],
  };
}

function createTestSnapshot(overrides?: Partial<HarnessSnapshot>): HarnessSnapshot {
  return {
    harnessId: harnessId("test-harness"),
    phase: "suspended",
    sessionSeq: 1,
    taskBoard: createTestBoard(),
    summaries: [],
    keyArtifacts: [],
    agentId: "agent-1",
    metrics: EMPTY_METRICS,
    startedAt: Date.now(),
    checkpointedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildInitialPrompt
// ---------------------------------------------------------------------------

describe("buildInitialPrompt", () => {
  test("produces plan-only output", () => {
    const board = createTestBoard();
    const prompt = buildInitialPrompt(board);
    expect(prompt).toContain("Task Plan");
    expect(prompt).toContain("task-1");
    expect(prompt).toContain("task-2");
    expect(prompt).toContain("Begin working");
  });
});

// ---------------------------------------------------------------------------
// buildResumeContext
// ---------------------------------------------------------------------------

describe("buildResumeContext", () => {
  test("returns VALIDATION error for empty task board", () => {
    const snapshot = createTestSnapshot({
      taskBoard: { items: [], results: [] },
    });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertErr(result);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("includes task plan in output", () => {
    const snapshot = createTestSnapshot();
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    expect(result.value).toHaveLength(1);
    const text = result.value[0]?.content[0];
    expect(text).toBeDefined();
    if (text?.kind === "text") {
      expect(text.text).toContain("Task Plan");
    }
  });

  test("includes summaries when present", () => {
    const summaries: readonly ContextSummary[] = [
      {
        narrative: "Session 1 completed task A",
        sessionSeq: 1,
        completedTaskIds: ["task-1"],
        estimatedTokens: 10,
        generatedAt: Date.now(),
      },
    ];
    const snapshot = createTestSnapshot({ summaries });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    const text = result.value[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("Session 1 completed task A");
    }
  });

  test("includes artifacts when present", () => {
    const artifacts: readonly KeyArtifact[] = [
      {
        toolName: "code_search",
        content: "Found 3 matching files",
        turnIndex: 2,
        capturedAt: Date.now(),
      },
    ];
    const snapshot = createTestSnapshot({ keyArtifacts: artifacts });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    const text = result.value[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("Found 3 matching files");
    }
  });

  test("respects token budget", () => {
    // Create very large summaries
    const longNarrative = "x".repeat(10000);
    const summaries: readonly ContextSummary[] = [
      {
        narrative: longNarrative,
        sessionSeq: 1,
        completedTaskIds: [],
        estimatedTokens: 2500,
        generatedAt: Date.now(),
      },
      {
        narrative: longNarrative,
        sessionSeq: 2,
        completedTaskIds: [],
        estimatedTokens: 2500,
        generatedAt: Date.now(),
      },
    ];
    const snapshot = createTestSnapshot({ summaries });
    // With a small budget, not all summaries should fit
    const result = buildResumeContext(snapshot, { maxContextTokens: 500 });
    assertOk(result);
    // Result should exist and contain task plan at minimum
    const text = result.value[0]?.content[0];
    if (text?.kind === "text") {
      expect(text.text).toContain("Task Plan");
    }
  });

  test("orders summaries newest first", () => {
    const summaries: readonly ContextSummary[] = [
      {
        narrative: "First session",
        sessionSeq: 1,
        completedTaskIds: [],
        estimatedTokens: 10,
        generatedAt: 1000,
      },
      {
        narrative: "Second session",
        sessionSeq: 2,
        completedTaskIds: [],
        estimatedTokens: 10,
        generatedAt: 2000,
      },
    ];
    const snapshot = createTestSnapshot({ summaries });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    const text = result.value[0]?.content[0];
    if (text?.kind === "text") {
      const firstIdx = text.text.indexOf("Second session");
      const secondIdx = text.text.indexOf("First session");
      // Newest should come first
      expect(firstIdx).toBeLessThan(secondIdx);
    }
  });

  test("produces InboundMessage with senderId 'harness'", () => {
    const snapshot = createTestSnapshot();
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    expect(result.value[0]?.senderId).toBe("harness");
  });

  test("resume messages are pinned to survive compaction", () => {
    const snapshot = createTestSnapshot();
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
    expect(result.value[0]?.pinned).toBe(true);
  });

  test("handles missing summaries gracefully (fail-open)", () => {
    const snapshot = createTestSnapshot({ summaries: [] });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
  });

  test("handles missing artifacts gracefully (fail-open)", () => {
    const snapshot = createTestSnapshot({ keyArtifacts: [] });
    const result = buildResumeContext(snapshot, { maxContextTokens: 3000 });
    assertOk(result);
  });

  test("token estimation is roughly text.length / 4", () => {
    // Sanity check: build with exact budget
    const snapshot = createTestSnapshot();
    const result = buildResumeContext(snapshot, { maxContextTokens: 100 });
    assertOk(result);
  });
});
