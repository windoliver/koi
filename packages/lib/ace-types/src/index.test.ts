import { describe, expect, test } from "bun:test";

import type {
  AggregatedStats,
  CuratorOperation,
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProvenance,
  PromotionThresholds,
  StructuredPlaybook,
  TrajectoryEntry,
  TrajectoryRange,
} from "./index.js";

describe("@koi/ace-types", () => {
  test("module loads", async () => {
    const mod = await import("./index.js");
    expect(typeof mod).toBe("object");
  });

  test("TrajectoryEntry compiles with required + optional fields", () => {
    const entry: TrajectoryEntry = {
      turnIndex: 0,
      timestamp: 1,
      kind: "tool_call",
      identifier: "fs.read",
      outcome: "success",
      durationMs: 12,
      bulletIds: ["b1"],
    };
    expect(entry.kind).toBe("tool_call");
  });

  test("AggregatedStats accumulator shape", () => {
    const stats: AggregatedStats = {
      identifier: "model:opus",
      kind: "model_call",
      successes: 3,
      failures: 1,
      retries: 0,
      totalDurationMs: 4321,
      invocations: 4,
      lastSeenMs: 99,
    };
    expect(stats.invocations).toBe(stats.successes + stats.failures + stats.retries);
  });

  test("CuratorOperation discriminates on kind", () => {
    const ops: readonly CuratorOperation[] = [
      { kind: "add", section: "tools", content: "always check existence" },
      { kind: "merge", bulletIds: ["a", "b"], content: "merged" },
      { kind: "prune", bulletId: "c" },
    ];
    const kinds = ops.map((op) => op.kind);
    expect(kinds).toEqual(["add", "merge", "prune"]);
  });

  test("Playbook carries version + optional provenance", () => {
    const range: TrajectoryRange = {
      sessionId: "s1",
      fromStepIndex: 0,
      toStepIndex: 10,
    };
    const provenance: PlaybookProvenance = {
      sourceTrajectoryRange: range,
      proposalId: "p1",
      evaluationId: "e1",
      committedAt: 100,
    };
    const pb: Playbook = {
      id: "pb-1",
      title: "t",
      strategy: "s",
      tags: [],
      confidence: 0.9,
      source: "curated",
      createdAt: 0,
      updatedAt: 100,
      sessionCount: 1,
      version: 1,
      provenance,
    };
    expect(pb.provenance?.proposalId).toBe("p1");
  });

  test("StructuredPlaybook supports lineage watermark", () => {
    const pb: StructuredPlaybook = {
      id: "spb-1",
      title: "t",
      sections: [],
      tags: [],
      source: "curated",
      createdAt: 0,
      updatedAt: 0,
      sessionCount: 0,
      version: 0,
      lastReflectedStepIndex: 42,
    };
    expect(pb.lastReflectedStepIndex).toBe(42);
  });

  test("PromotionThresholds + Evaluation + Proposal compose for the gate", () => {
    const thresholds: PromotionThresholds = {
      minHelpfulRate: 0.6,
      maxHarmfulRate: 0.1,
      minTrials: 5,
    };
    const proposal: PlaybookProposal = {
      id: "p1",
      playbookId: "spb-1",
      baseVersion: 0,
      operations: [{ kind: "add", section: "tools", content: "x" }],
      sourceTrajectoryRange: { sessionId: "s", fromStepIndex: 0, toStepIndex: 1 },
      reflection: { rootCause: "rc", keyInsight: "ki", bulletTags: [] },
      createdAt: 0,
    };
    const evaluation: PlaybookEvaluation = {
      id: "e1",
      proposalId: proposal.id,
      verdict: "reject",
      metrics: { helpfulRate: 0.2 },
      notes: "below minHelpfulRate",
      evaluatedAt: 1,
    };
    expect(thresholds.minTrials).toBeGreaterThan(0);
    expect(evaluation.verdict).toBe("reject");
    expect(evaluation.metrics.helpfulRate).toBeLessThan(thresholds.minHelpfulRate);
  });
});
