/**
 * Unit tests for map-snapshot pure mapping functions.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId, ContextSummary, HarnessSnapshot, KeyArtifact, TaskResult } from "@koi/core";
import { agentId, handoffId, harnessId, taskItemId } from "@koi/core";
import {
  generateCompletedPhaseDescription,
  generateWarnings,
  mapContextSummaryToDecisionRecord,
  mapKeyArtifactToArtifactRef,
  mapSnapshotToEnvelope,
  mapTaskResultsToJsonObject,
} from "./map-snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_A: AgentId = agentId("agent-a");
const AGENT_B: AgentId = agentId("agent-b");

function createKeyArtifact(overrides?: Partial<KeyArtifact>): KeyArtifact {
  return {
    toolName: "file_write",
    content: "some output content",
    turnIndex: 5,
    capturedAt: 1700000000000,
    ...overrides,
  };
}

function createContextSummary(overrides?: Partial<ContextSummary>): ContextSummary {
  return {
    narrative: "Session completed 2 tasks and produced an analysis report.",
    sessionSeq: 1,
    completedTaskIds: ["task-1", "task-2"],
    estimatedTokens: 500,
    generatedAt: 1700000001000,
    ...overrides,
  };
}

function createTaskResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    taskId: taskItemId("task-1"),
    output: "Task completed successfully",
    durationMs: 5000,
    ...overrides,
  };
}

function createSnapshot(overrides?: Partial<HarnessSnapshot>): HarnessSnapshot {
  return {
    harnessId: harnessId("harness-1"),
    phase: "completed",
    sessionSeq: 2,
    taskBoard: {
      items: [],
      results: [createTaskResult()],
    },
    summaries: [createContextSummary()],
    keyArtifacts: [createKeyArtifact()],
    agentId: "agent-a",
    metrics: {
      totalSessions: 2,
      totalTurns: 15,
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
      completedTaskCount: 3,
      pendingTaskCount: 0,
      elapsedMs: 120000,
    },
    startedAt: 1700000000000,
    checkpointedAt: 1700000120000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mapKeyArtifactToArtifactRef
// ---------------------------------------------------------------------------

describe("mapKeyArtifactToArtifactRef", () => {
  test("maps artifact to ArtifactRef with harness:// URI", () => {
    const artifact = createKeyArtifact();
    const ref = mapKeyArtifactToArtifactRef(artifact, 0);

    expect(ref.id).toBe("artifact-0");
    expect(ref.kind).toBe("data");
    expect(ref.uri).toBe("harness://artifact/file_write/5");
    expect(ref.metadata).toEqual({
      toolName: "file_write",
      turnIndex: 5,
      capturedAt: 1700000000000,
      preview: "some output content",
    });
  });

  test("truncates long content in preview", () => {
    const longContent = "a".repeat(300);
    const artifact = createKeyArtifact({ content: longContent });
    const ref = mapKeyArtifactToArtifactRef(artifact, 1);

    const preview = ref.metadata?.preview as string;
    expect(preview.length).toBe(203); // 200 + "..."
    expect(preview.endsWith("...")).toBe(true);
  });

  test("encodes special characters in tool name", () => {
    const artifact = createKeyArtifact({ toolName: "my tool/special" });
    const ref = mapKeyArtifactToArtifactRef(artifact, 0);

    expect(ref.uri).toBe("harness://artifact/my%20tool%2Fspecial/5");
  });

  test("uses index for id", () => {
    const artifact = createKeyArtifact();
    const ref = mapKeyArtifactToArtifactRef(artifact, 42);
    expect(ref.id).toBe("artifact-42");
  });
});

// ---------------------------------------------------------------------------
// mapContextSummaryToDecisionRecord
// ---------------------------------------------------------------------------

describe("mapContextSummaryToDecisionRecord", () => {
  test("maps summary to DecisionRecord", () => {
    const summary = createContextSummary();
    const record = mapContextSummaryToDecisionRecord(summary, AGENT_A);

    expect(record.agentId).toBe(AGENT_A);
    expect(record.action).toBe("session-1-summary");
    expect(record.reasoning).toBe(summary.narrative);
    expect(record.timestamp).toBe(summary.generatedAt);
    expect(record.toolCallId).toBeUndefined();
  });

  test("uses sessionSeq in action name", () => {
    const summary = createContextSummary({ sessionSeq: 7 });
    const record = mapContextSummaryToDecisionRecord(summary, AGENT_B);
    expect(record.action).toBe("session-7-summary");
  });
});

// ---------------------------------------------------------------------------
// mapTaskResultsToJsonObject
// ---------------------------------------------------------------------------

describe("mapTaskResultsToJsonObject", () => {
  test("maps results keyed by taskId", () => {
    const results = [
      createTaskResult({ taskId: taskItemId("t-1"), output: "out1", durationMs: 100 }),
      createTaskResult({
        taskId: taskItemId("t-2"),
        output: "out2",
        durationMs: 200,
        workerId: "w-1",
      }),
    ];

    const obj = mapTaskResultsToJsonObject(results);

    expect(obj["t-1"]).toEqual({ output: "out1", durationMs: 100 });
    expect(obj["t-2"]).toEqual({ output: "out2", durationMs: 200, workerId: "w-1" });
  });

  test("returns empty object for empty results", () => {
    const obj = mapTaskResultsToJsonObject([]);
    expect(obj).toEqual({});
  });

  test("omits workerId when undefined", () => {
    const results = [createTaskResult({ workerId: undefined })];
    const obj = mapTaskResultsToJsonObject(results);
    const entry = obj["task-1"] as Record<string, unknown>;
    expect("workerId" in entry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateCompletedPhaseDescription
// ---------------------------------------------------------------------------

describe("generateCompletedPhaseDescription", () => {
  test("generates human-readable description", () => {
    const snapshot = createSnapshot();
    const desc = generateCompletedPhaseDescription(snapshot);
    expect(desc).toBe("Completed 3/3 tasks across 2 sessions (120s elapsed)");
  });

  test("uses singular 'session' for 1 session", () => {
    const snapshot = createSnapshot({
      metrics: {
        totalSessions: 1,
        totalTurns: 5,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        completedTaskCount: 1,
        pendingTaskCount: 0,
        elapsedMs: 30000,
      },
    });
    const desc = generateCompletedPhaseDescription(snapshot);
    expect(desc).toBe("Completed 1/1 tasks across 1 session (30s elapsed)");
  });

  test("includes pending tasks in total", () => {
    const snapshot = createSnapshot({
      metrics: {
        totalSessions: 3,
        totalTurns: 20,
        totalInputTokens: 5000,
        totalOutputTokens: 3000,
        completedTaskCount: 2,
        pendingTaskCount: 1,
        elapsedMs: 60000,
      },
    });
    const desc = generateCompletedPhaseDescription(snapshot);
    expect(desc).toBe("Completed 2/3 tasks across 3 sessions (60s elapsed)");
  });
});

// ---------------------------------------------------------------------------
// generateWarnings
// ---------------------------------------------------------------------------

describe("generateWarnings", () => {
  test("returns empty array when no issues", () => {
    const snapshot = createSnapshot();
    const warnings = generateWarnings(snapshot);
    expect(warnings).toEqual([]);
  });

  test("warns about failed tasks", () => {
    const snapshot = createSnapshot({
      taskBoard: {
        items: [
          {
            id: taskItemId("task-1"),
            description: "Do something",
            dependencies: [],
            priority: 1,
            maxRetries: 3,
            retries: 3,
            status: "failed",
            error: {
              code: "TIMEOUT",
              message: "Timed out",
              retryable: true,
            },
          },
        ],
        results: [],
      },
    });

    const warnings = generateWarnings(snapshot);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe('Task "task-1" failed: Timed out');
  });

  test("warns about failed task with no error message", () => {
    const snapshot = createSnapshot({
      taskBoard: {
        items: [
          {
            id: taskItemId("task-1"),
            description: "Do something",
            dependencies: [],
            priority: 1,
            maxRetries: 3,
            retries: 3,
            status: "failed",
          },
        ],
        results: [],
      },
    });

    const warnings = generateWarnings(snapshot);
    expect(warnings[0]).toBe('Task "task-1" failed: unknown error');
  });

  test("warns about high session count", () => {
    const snapshot = createSnapshot({
      metrics: {
        totalSessions: 15,
        totalTurns: 100,
        totalInputTokens: 50000,
        totalOutputTokens: 25000,
        completedTaskCount: 5,
        pendingTaskCount: 0,
        elapsedMs: 600000,
      },
    });

    const warnings = generateWarnings(snapshot);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("High session count: 15 sessions used");
  });

  test("includes both failed tasks and high session warnings", () => {
    const snapshot = createSnapshot({
      taskBoard: {
        items: [
          {
            id: taskItemId("task-x"),
            description: "X",
            dependencies: [],
            priority: 1,
            maxRetries: 1,
            retries: 1,
            status: "failed",
            error: { code: "INTERNAL", message: "Boom", retryable: false },
          },
        ],
        results: [],
      },
      metrics: {
        totalSessions: 20,
        totalTurns: 200,
        totalInputTokens: 100000,
        totalOutputTokens: 50000,
        completedTaskCount: 10,
        pendingTaskCount: 0,
        elapsedMs: 1200000,
      },
    });

    const warnings = generateWarnings(snapshot);
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mapSnapshotToEnvelope
// ---------------------------------------------------------------------------

describe("mapSnapshotToEnvelope", () => {
  test("maps completed snapshot to full envelope", () => {
    const snapshot = createSnapshot();
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B);

    expect(envelope.from).toBe(AGENT_A);
    expect(envelope.to).toBe(AGENT_B);
    expect(envelope.status).toBe("pending");
    expect(envelope.phase.completed).toBe("Completed 3/3 tasks across 2 sessions (120s elapsed)");
    expect(envelope.phase.next).toContain("Continue from:");
    expect(envelope.context.artifacts).toHaveLength(1);
    expect(envelope.context.decisions).toHaveLength(1);
    expect(envelope.context.results).toHaveProperty("task-1");
    expect(envelope.metadata).toEqual({
      harnessId: "harness-1",
      sessionSeq: 2,
      elapsedMs: 120000,
    });
  });

  test("uses custom nextPhaseInstructions when provided", () => {
    const snapshot = createSnapshot();
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B, "Deploy to production");

    expect(envelope.phase.next).toBe("Deploy to production");
  });

  test("generates default next phase when no instructions given", () => {
    const snapshot = createSnapshot();
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B);

    expect(envelope.phase.next).toMatch(/^Continue from:/);
  });

  test("handles empty artifacts and summaries", () => {
    const snapshot = createSnapshot({
      keyArtifacts: [],
      summaries: [],
    });
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B);

    expect(envelope.context.artifacts).toEqual([]);
    expect(envelope.context.decisions).toEqual([]);
  });

  test("generates a valid HandoffId", () => {
    const snapshot = createSnapshot();
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B);

    // Should be a non-empty string
    expect(typeof envelope.id).toBe("string");
    expect(envelope.id.length).toBeGreaterThan(0);
  });

  test("generates deterministic ID from harnessId and sessionSeq", () => {
    const snapshot = createSnapshot({
      harnessId: harnessId("my-harness"),
      sessionSeq: 5,
    });
    const envelope = mapSnapshotToEnvelope(snapshot, AGENT_B);

    expect(envelope.id).toBe(handoffId("harness-handoff-my-harness-5"));
  });

  test("same snapshot produces same ID on repeated calls", () => {
    const snapshot = createSnapshot();
    const envelope1 = mapSnapshotToEnvelope(snapshot, AGENT_B);
    const envelope2 = mapSnapshotToEnvelope(snapshot, AGENT_B);

    expect(envelope1.id).toBe(envelope2.id);
  });
});
