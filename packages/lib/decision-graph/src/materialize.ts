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
  for (const step of sortedSteps) {
    const node = trajectoryNode(snapshot.sessionId, step);
    nodes.push(node);
    edges.push(edge(snapshot.sessionId, "contains", sessionNodeId(snapshot.sessionId), node.id));
  }
  for (let i = 1; i < sortedSteps.length; i += 1) {
    edges.push(
      edge(
        snapshot.sessionId,
        "precedes",
        trajectoryNodeId(snapshot.sessionId, sortedSteps[i - 1]?.stepIndex ?? 0),
        trajectoryNodeId(snapshot.sessionId, sortedSteps[i]?.stepIndex ?? 0),
      ),
    );
  }

  for (const [index, entry] of snapshot.auditEntries.entries()) {
    const node = auditNode(snapshot.sessionId, entry, index);
    nodes.push(node);
    edges.push(edge(snapshot.sessionId, "contains", sessionNodeId(snapshot.sessionId), node.id));
    const matchingStep = sortedSteps.find(
      (step) =>
        step.timestamp <= entry.timestamp &&
        (entry.toolName === undefined || step.identifier === entry.toolName),
    );
    if (matchingStep !== undefined) {
      edges.push(
        edge(
          snapshot.sessionId,
          "corroborates",
          node.id,
          trajectoryNodeId(snapshot.sessionId, matchingStep.stepIndex),
        ),
      );
    }
  }

  for (const outcome of snapshot.outcomeReports ?? []) {
    const node = outcomeNode(snapshot.sessionId, outcome);
    nodes.push(node);
    const matchingStep = sortedSteps.find(
      (step) => metadataString(step.metadata, "decisionCorrelationId") === outcome.correlationId,
    );
    edges.push(edge(snapshot.sessionId, "contains", sessionNodeId(snapshot.sessionId), node.id));
    if (matchingStep !== undefined) {
      edges.push(
        edge(
          snapshot.sessionId,
          "produced",
          trajectoryNodeId(snapshot.sessionId, matchingStep.stepIndex),
          node.id,
        ),
      );
    }
  }

  const report = snapshot.runReport;
  if (report !== undefined) {
    const reportNode = runReportNode(snapshot.sessionId, report);
    nodes.push(reportNode);
    edges.push(
      edge(snapshot.sessionId, "summarizes", reportNode.id, sessionNodeId(snapshot.sessionId)),
    );
    for (const [index, issue] of report.issues.entries()) {
      const issueId = issueNodeId(snapshot.sessionId, report.runId, index);
      nodes.push({
        id: issueId,
        sessionId: snapshot.sessionId,
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
      edges.push(edge(snapshot.sessionId, "raises", reportNode.id, issueId));
    }
    for (const [index, recommendation] of report.recommendations.entries()) {
      const recommendationId = recommendationNodeId(snapshot.sessionId, report.runId, index);
      nodes.push({
        id: recommendationId,
        sessionId: snapshot.sessionId,
        kind: "recommendation",
        label: recommendation,
        timestamp: report.duration.completedAt,
      });
      edges.push(edge(snapshot.sessionId, "recommends", reportNode.id, recommendationId));
    }
  }

  return { sessionId: snapshot.sessionId, nodes, edges: dedupeEdges(edges) };
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
