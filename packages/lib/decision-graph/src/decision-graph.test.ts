import { describe, expect, test } from "bun:test";
import type { AuditEntry, RichTrajectoryStep } from "@koi/core";
import { agentId, decisionCorrelationId, runId, sessionId } from "@koi/core";
import { createInMemoryDecisionGraphStore } from "./in-memory-store.js";
import { materializeDecisionGraph } from "./materialize.js";
import type { DecisionGraphLedgerSnapshot } from "./types.js";

function makeStep(index: number, identifier: string): RichTrajectoryStep {
  const step: RichTrajectoryStep = {
    stepIndex: index,
    timestamp: 1_700_000_000_000 + index,
    source: "agent",
    kind: "tool_call",
    identifier,
    outcome: "success",
    durationMs: 10,
    request: { text: identifier },
    response: { text: "ok" },
  };
  return index === 1 ? { ...step, metadata: { decisionCorrelationId: "dcid-1" } } : step;
}

function makeAudit(toolName: string): AuditEntry {
  return {
    schema_version: 1,
    timestamp: 1_700_000_000_010,
    sessionId: "session-a",
    agentId: "agent-a",
    turnIndex: 1,
    kind: "tool_call",
    toolName,
    durationMs: 11,
  };
}

function makeSnapshot(session = "session-a"): DecisionGraphLedgerSnapshot {
  return {
    sessionId: session,
    trajectorySteps: [makeStep(0, "read_file"), makeStep(1, "apply_patch")],
    auditEntries: [makeAudit("apply_patch")],
    outcomeReports: [
      {
        correlationId: decisionCorrelationId("dcid-1"),
        outcome: "positive",
        description: "Customer impact improved",
        metrics: { conversion_delta: 0.12 },
        reportedBy: "test",
        timestamp: 1_700_000_000_020,
      },
    ],
    runReport: {
      agentId: agentId("agent-a"),
      sessionId: sessionId(session),
      runId: runId(`run-${session}`),
      summary: "Implemented the patch",
      duration: {
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        totalTurns: 1,
        totalActions: 2,
        truncated: false,
      },
      actions: [],
      artifacts: [],
      issues: [{ severity: "warning", message: "Needs follow-up", turnIndex: 1, resolved: false }],
      cost: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      recommendations: ["Run broader verification"],
    },
    integrityLeakCounts: { audit: 0, report: 0 },
  };
}

describe("materializeDecisionGraph", () => {
  test("materializes trajectory, audit, report, issue, and recommendation nodes", () => {
    const graph = materializeDecisionGraph(makeSnapshot());

    expect(graph.nodes.map((node) => node.kind)).toContain("session");
    expect(graph.nodes.map((node) => node.kind)).toContain("trajectory_step");
    expect(graph.nodes.map((node) => node.kind)).toContain("audit_entry");
    expect(graph.nodes.map((node) => node.kind)).toContain("outcome");
    expect(graph.nodes.map((node) => node.kind)).toContain("run_report");
    expect(graph.nodes.map((node) => node.kind)).toContain("issue");
    expect(graph.nodes.map((node) => node.kind)).toContain("recommendation");
    expect(graph.edges.map((edge) => edge.kind)).toContain("precedes");
    expect(graph.edges.map((edge) => edge.kind)).toContain("corroborates");
    expect(graph.edges.map((edge) => edge.kind)).toContain("produced");
    const outcome = graph.nodes.find((node) => node.kind === "outcome");
    const producer = graph.nodes.find(
      (node) => node.kind === "trajectory_step" && node.stepIndex === 1,
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "produced",
        from: producer?.id,
        to: outcome?.id,
      }),
    );
  });

  test("refuses snapshots with integrity leaks", () => {
    expect(() =>
      materializeDecisionGraph({
        ...makeSnapshot(),
        integrityLeakCounts: { audit: 1, report: 0 },
      }),
    ).toThrow("integrity leaks");
  });

  test("does not infer audit corroboration from timestamp alone", () => {
    const audit = makeAudit("apply_patch");
    const graph = materializeDecisionGraph({
      ...makeSnapshot(),
      auditEntries: [
        {
          schema_version: audit.schema_version,
          timestamp: 1_700_000_000_999,
          sessionId: audit.sessionId,
          agentId: audit.agentId,
          turnIndex: audit.turnIndex,
          kind: audit.kind,
          durationMs: audit.durationMs,
        },
      ],
    });

    expect(graph.edges.map((edge) => edge.kind)).not.toContain("corroborates");
  });

  test("corroborates the nearest prior trajectory step with the same tool name", () => {
    const graph = materializeDecisionGraph({
      ...makeSnapshot(),
      trajectorySteps: [makeStep(0, "apply_patch"), makeStep(1, "apply_patch")],
      auditEntries: [
        {
          ...makeAudit("apply_patch"),
          timestamp: 1_700_000_000_999,
        },
      ],
    });

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "corroborates",
        to: "trajectory:session-a:1",
      }),
    );
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({
        kind: "corroborates",
        to: "trajectory:session-a:0",
      }),
    );
  });
});

describe("createInMemoryDecisionGraphStore", () => {
  test("keeps sessions scoped and supports neighbor queries", async () => {
    const store = createInMemoryDecisionGraphStore();
    const graphA = materializeDecisionGraph(makeSnapshot("session-a"));
    const graphB = materializeDecisionGraph(makeSnapshot("session-b"));
    await store.upsertGraph(graphA);
    await store.upsertGraph(graphB);

    const sessionNode = graphA.nodes.find((node) => node.kind === "session");
    if (sessionNode === undefined) throw new Error("missing session node");
    const neighbors = await store.getNeighbors({
      sessionId: "session-a",
      nodeId: sessionNode.id,
      direction: "outgoing",
      hops: 1,
    });

    expect(neighbors.ok).toBe(true);
    if (!neighbors.ok) return;
    expect(neighbors.value.sessionId).toBe("session-a");
    expect(neighbors.value.nodes.every((node) => node.sessionId === "session-a")).toBe(true);
    expect(neighbors.value.nodes.some((node) => node.kind === "trajectory_step")).toBe(true);
  });

  test("supports subgraph expansion by hops", async () => {
    const store = createInMemoryDecisionGraphStore();
    const graph = materializeDecisionGraph(makeSnapshot());
    await store.upsertGraph(graph);
    const firstStep = graph.nodes.find((node) => node.kind === "trajectory_step");
    if (firstStep === undefined) throw new Error("missing trajectory node");

    const subgraph = await store.getSubgraph({
      sessionId: "session-a",
      nodeIds: [firstStep.id],
      hops: 1,
    });

    expect(subgraph.ok).toBe(true);
    if (!subgraph.ok) return;
    expect(subgraph.value.nodes.length).toBeGreaterThan(1);
    expect(subgraph.value.edges.length).toBeGreaterThan(0);
  });
});
