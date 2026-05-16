import type { JsonObject } from "@koi/core";
import { validationError } from "./errors.js";
import type {
  DecisionGraph,
  DecisionGraphEdge,
  DecisionGraphLedgerSnapshot,
  DecisionGraphNode,
} from "./types.js";

export function materializeDecisionGraph(snapshot: DecisionGraphLedgerSnapshot): DecisionGraph {
  validateSnapshot(snapshot);

  const nodes: DecisionGraphNode[] = [
    {
      id: sessionNodeId(snapshot.sessionId),
      sessionId: snapshot.sessionId,
      kind: "session",
      label: snapshot.sessionId,
    },
  ];
  const edges: DecisionGraphEdge[] = [];

  const sortedSteps = [...snapshot.trajectorySteps].sort((a, b) => a.stepIndex - b.stepIndex);
  addTrajectoryNodes(snapshot.sessionId, sortedSteps, nodes, edges);
  addAuditNodes(snapshot, sortedSteps, nodes, edges);
  addOutcomeNodes(snapshot, sortedSteps, nodes, edges);
  addRunReportNodes(snapshot, nodes, edges);

  return { sessionId: snapshot.sessionId, nodes, edges: dedupeEdges(edges) };
}

function addTrajectoryNodes(
  sessionId: string,
  sortedSteps: readonly DecisionGraphLedgerSnapshot["trajectorySteps"][number][],
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  for (const step of sortedSteps) {
    const node = trajectoryNode(sessionId, step);
    nodes.push(node);
    edges.push(edge(sessionId, "contains", sessionNodeId(sessionId), node.id));
  }
  for (let i = 1; i < sortedSteps.length; i += 1) {
    edges.push(
      edge(
        sessionId,
        "precedes",
        trajectoryNodeId(sessionId, sortedSteps[i - 1]?.stepIndex ?? 0),
        trajectoryNodeId(sessionId, sortedSteps[i]?.stepIndex ?? 0),
      ),
    );
  }
}

function addAuditNodes(
  snapshot: DecisionGraphLedgerSnapshot,
  sortedSteps: readonly DecisionGraphLedgerSnapshot["trajectorySteps"][number][],
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  for (const [index, entry] of snapshot.auditEntries.entries()) {
    const node = auditNode(snapshot.sessionId, entry, index);
    nodes.push(node);
    edges.push(edge(snapshot.sessionId, "contains", sessionNodeId(snapshot.sessionId), node.id));
    const matchingStep =
      entry.toolName !== undefined
        ? sortedSteps.findLast(
            (step) => step.timestamp <= entry.timestamp && step.identifier === entry.toolName,
          )
        : undefined;
    if (matchingStep !== undefined) {
      edges.push(corroboratesEdge(snapshot.sessionId, node.id, matchingStep.stepIndex));
    }
  }
}

function addOutcomeNodes(
  snapshot: DecisionGraphLedgerSnapshot,
  sortedSteps: readonly DecisionGraphLedgerSnapshot["trajectorySteps"][number][],
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  for (const outcome of snapshot.outcomeReports ?? []) {
    const node = outcomeNode(snapshot.sessionId, outcome);
    nodes.push(node);
    edges.push(edge(snapshot.sessionId, "contains", sessionNodeId(snapshot.sessionId), node.id));
    const matchingStep = sortedSteps.find(
      (step) => metadataString(step.metadata, "decisionCorrelationId") === outcome.correlationId,
    );
    if (matchingStep !== undefined) {
      edges.push(producedEdge(snapshot.sessionId, matchingStep.stepIndex, node.id));
    }
  }
}

function addRunReportNodes(
  snapshot: DecisionGraphLedgerSnapshot,
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  const report = snapshot.runReport;
  if (report === undefined) return;
  const reportNode = runReportNode(snapshot.sessionId, report);
  nodes.push(reportNode);
  edges.push(
    edge(snapshot.sessionId, "summarizes", reportNode.id, sessionNodeId(snapshot.sessionId)),
  );
  addIssueNodes(snapshot.sessionId, report, reportNode.id, nodes, edges);
  addRecommendationNodes(snapshot.sessionId, report, reportNode.id, nodes, edges);
}

function addIssueNodes(
  sessionId: string,
  report: NonNullable<DecisionGraphLedgerSnapshot["runReport"]>,
  reportNodeIdValue: string,
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  for (const [index, issue] of report.issues.entries()) {
    const issueId = issueNodeId(sessionId, report.runId, index);
    nodes.push({
      id: issueId,
      sessionId,
      kind: "issue",
      label: issue.message,
      timestamp: report.duration.completedAt,
      metadata: {
        severity: issue.severity,
        turnIndex: issue.turnIndex,
        resolved: issue.resolved,
        ...(issue.resolution !== undefined ? { resolution: issue.resolution } : {}),
      },
    });
    edges.push(edge(sessionId, "raises", reportNodeIdValue, issueId));
  }
}

function addRecommendationNodes(
  sessionId: string,
  report: NonNullable<DecisionGraphLedgerSnapshot["runReport"]>,
  reportNodeIdValue: string,
  nodes: DecisionGraphNode[],
  edges: DecisionGraphEdge[],
): void {
  for (const [index, recommendation] of report.recommendations.entries()) {
    const recommendationId = recommendationNodeId(sessionId, report.runId, index);
    nodes.push({
      id: recommendationId,
      sessionId,
      kind: "recommendation",
      label: recommendation,
      timestamp: report.duration.completedAt,
    });
    edges.push(edge(sessionId, "recommends", reportNodeIdValue, recommendationId));
  }
}

function validateSnapshot(snapshot: DecisionGraphLedgerSnapshot): void {
  if (snapshot.sessionId.trim().length === 0) {
    throw new Error(validationError("sessionId must not be empty").message);
  }
  if (snapshot.integrityLeakCounts.audit !== 0 || snapshot.integrityLeakCounts.report !== 0) {
    throw new Error("refusing to materialize graph with integrity leaks");
  }
}

function trajectoryNode(
  sessionId: string,
  step: {
    readonly stepIndex: number;
    readonly timestamp: number;
    readonly kind: string;
    readonly identifier: string;
    readonly outcome: string;
  },
): DecisionGraphNode {
  return {
    id: trajectoryNodeId(sessionId, step.stepIndex),
    sessionId,
    kind: "trajectory_step",
    label: `${step.kind}:${step.identifier}`,
    timestamp: step.timestamp,
    stepIndex: step.stepIndex,
    metadata: {
      identifier: step.identifier,
      outcome: step.outcome,
    },
  };
}

function auditNode(
  sessionId: string,
  entry: {
    readonly timestamp: number;
    readonly turnIndex: number;
    readonly kind: string;
    readonly toolName?: string | undefined;
    readonly metadata?: JsonObject | undefined;
  },
  index: number,
): DecisionGraphNode {
  return {
    id: auditNodeId(sessionId, entry, index),
    sessionId,
    kind: "audit_entry",
    label: entry.toolName ?? entry.kind,
    timestamp: entry.timestamp,
    metadata: {
      auditKind: entry.kind,
      turnIndex: entry.turnIndex,
      ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
      ...(entry.metadata !== undefined ? { auditMetadata: entry.metadata } : {}),
    },
  };
}

function runReportNode(
  sessionId: string,
  report: {
    readonly runId: string;
    readonly summary: string;
    readonly objective?: string | undefined;
    readonly duration: { readonly completedAt: number; readonly totalTurns: number };
  },
): DecisionGraphNode {
  return {
    id: reportNodeId(sessionId, report.runId),
    sessionId,
    kind: "run_report",
    label: report.summary,
    timestamp: report.duration.completedAt,
    metadata: {
      runId: report.runId,
      totalTurns: report.duration.totalTurns,
      ...(report.objective !== undefined ? { objective: report.objective } : {}),
    },
  };
}

function outcomeNode(
  sessionId: string,
  outcome: {
    readonly correlationId: string;
    readonly outcome: string;
    readonly description: string;
    readonly timestamp: number;
    readonly reportedBy: string;
    readonly metrics: Readonly<Record<string, number>>;
    readonly metadata?: JsonObject | undefined;
  },
): DecisionGraphNode {
  return {
    id: outcomeNodeId(sessionId, outcome.correlationId),
    sessionId,
    kind: "outcome",
    label: outcome.description,
    timestamp: outcome.timestamp,
    metadata: {
      correlationId: outcome.correlationId,
      outcome: outcome.outcome,
      reportedBy: outcome.reportedBy,
      metrics: outcome.metrics,
      ...(outcome.metadata !== undefined ? { outcomeMetadata: outcome.metadata } : {}),
    },
  };
}

function edge(
  sessionId: string,
  kind: DecisionGraphEdge["kind"],
  from: string,
  to: string,
): DecisionGraphEdge {
  return {
    id: `${kind}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`,
    sessionId,
    kind,
    from,
    to,
  };
}

function corroboratesEdge(
  sessionId: string,
  auditNodeIdValue: string,
  stepIndex: number,
): DecisionGraphEdge {
  return edge(sessionId, "corroborates", auditNodeIdValue, trajectoryNodeId(sessionId, stepIndex));
}

function producedEdge(sessionId: string, stepIndex: number, outcomeNodeIdValue: string) {
  return edge(sessionId, "produced", trajectoryNodeId(sessionId, stepIndex), outcomeNodeIdValue);
}

function dedupeEdges(edges: readonly DecisionGraphEdge[]): readonly DecisionGraphEdge[] {
  return [...new Map(edges.map((item) => [item.id, item])).values()];
}

function sessionNodeId(sessionId: string): string {
  return `session:${encodeURIComponent(sessionId)}`;
}

function trajectoryNodeId(sessionId: string, stepIndex: number): string {
  return `trajectory:${encodeURIComponent(sessionId)}:${stepIndex}`;
}

function auditNodeId(
  sessionId: string,
  entry: { readonly timestamp: number; readonly turnIndex: number; readonly kind: string },
  index: number,
): string {
  return `audit:${encodeURIComponent(sessionId)}:${index}:${entry.timestamp}:${entry.turnIndex}:${entry.kind}`;
}

function reportNodeId(sessionId: string, runId: string): string {
  return `report:${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}`;
}

function issueNodeId(sessionId: string, runId: string, index: number): string {
  return `issue:${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}:${index}`;
}

function recommendationNodeId(sessionId: string, runId: string, index: number): string {
  return `recommendation:${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}:${index}`;
}

function outcomeNodeId(sessionId: string, correlationId: string): string {
  return `outcome:${encodeURIComponent(sessionId)}:${encodeURIComponent(correlationId)}`;
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
