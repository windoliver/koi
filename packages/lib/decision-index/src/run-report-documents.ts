import type { IndexDocument } from "@koi/core";
import type {
  DecisionIndexDocumentData,
  DecisionIndexSourceKind,
  DecisionLedgerSnapshot,
} from "./types.js";

export function runReportDocuments(
  snapshot: DecisionLedgerSnapshot,
  indexedAtMs: number,
): readonly IndexDocument<DecisionIndexDocumentData>[] {
  const report = snapshot.runReport;
  if (report === undefined) return [];

  const sourceKind: DecisionIndexSourceKind = "run_report";
  const base = {
    data: { sessionId: snapshot.sessionId, sourceKind },
    metadata: {
      sessionId: snapshot.sessionId,
      sourceKind,
      source: "run_report",
      indexedAtMs,
    },
  };
  const completedAt = report.duration.completedAt;
  const summary = runReportDocument(snapshot.sessionId, {
    base,
    content: compactContent([report.summary, report.objective]),
    reportSection: "summary",
    sourceId: `summary:${report.runId}`,
    timestamp: completedAt,
    title: "run report summary",
  });
  const issueDocs = report.issues.map((issue, index) =>
    runReportDocument(snapshot.sessionId, {
      base,
      content: compactContent([issue.severity, issue.message, issue.resolution]),
      reportSection: "issue",
      sourceId: `issue:${report.runId}:${index}`,
      timestamp: completedAt,
      title: `run report issue:${issue.severity}`,
    }),
  );
  const recommendationDocs = report.recommendations.map((recommendation, index) =>
    runReportDocument(snapshot.sessionId, {
      base,
      content: recommendation,
      reportSection: "recommendation",
      sourceId: `recommendation:${report.runId}:${index}`,
      timestamp: completedAt,
      title: "run report recommendation",
    }),
  );

  return [summary, ...issueDocs, ...recommendationDocs];
}

interface RunReportDocumentInput {
  readonly base: {
    readonly data: Pick<DecisionIndexDocumentData, "sessionId" | "sourceKind">;
    readonly metadata: Readonly<Record<string, string | number>>;
  };
  readonly content: string;
  readonly reportSection: "summary" | "issue" | "recommendation";
  readonly sourceId: string;
  readonly timestamp: number;
  readonly title: string;
}

function runReportDocument(
  sessionId: string,
  input: RunReportDocumentInput,
): IndexDocument<DecisionIndexDocumentData> {
  return {
    id: decisionDocumentId(sessionId, "run_report", input.sourceId),
    content: input.content,
    metadata: {
      ...input.base.metadata,
      sourceId: input.sourceId,
      reportSection: input.reportSection,
      timestamp: input.timestamp,
    },
    data: {
      ...input.base.data,
      sourceId: input.sourceId,
      title: input.title,
      timestamp: input.timestamp,
      reportSection: input.reportSection,
    },
  };
}

function decisionDocumentId(sessionId: string, sourceKind: string, sourceId: string): string {
  return `decision:${encodeURIComponent(sessionId)}:${sourceKind}:${encodeURIComponent(sourceId)}`;
}

function compactContent(parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part.trim().length > 0).join("\n");
}
