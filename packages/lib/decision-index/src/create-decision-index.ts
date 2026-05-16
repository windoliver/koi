import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  RichContent,
  RichTrajectoryStep,
  SearchFilter,
} from "@koi/core";
import { DEFAULT_SEARCH_LIMIT, type Result } from "@koi/core";
import { internalError, validationError } from "./errors.js";
import type {
  DecisionIndex,
  DecisionIndexConfig,
  DecisionIndexDocumentData,
  DecisionIndexHit,
  DecisionIndexIndexedSourceKind,
  DecisionIndexPage,
  DecisionIndexQuery,
  DecisionIndexSearchResult,
  DecisionIndexSourceKind,
  DecisionLedgerSnapshot,
} from "./types.js";

const SESSION_MARKER_CONTENT = "__koi_decision_index_session_marker__";

export function createDecisionIndex(config: DecisionIndexConfig): DecisionIndex {
  return {
    indexSession: (snapshot) => indexSessionImpl(config, snapshot),
    queryDecisions: (query) => queryDecisionsImpl(config, query),
  };
}

async function indexSessionImpl(
  config: DecisionIndexConfig,
  snapshot: DecisionLedgerSnapshot,
): Promise<Result<void, KoiError>> {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) return validation;

  try {
    const previousIds = await readPreviousDocumentIds(config, snapshot.sessionId);
    if (!previousIds.ok) return previousIds;

    const indexedAtMs = config.clock?.() ?? Date.now();
    const decisionDocuments = buildDecisionDocuments(snapshot, indexedAtMs);
    const documents = [
      ...decisionDocuments,
      sessionMarkerDocument(snapshot.sessionId, indexedAtMs, [
        ...decisionDocuments.map((doc) => doc.id),
        sessionMarkerDocumentId(snapshot.sessionId),
      ]),
    ];
    if (previousIds.value.length > 0) {
      const removeResult = await config.backend.remove(previousIds.value);
      if (!removeResult.ok) return removeResult;
    }
    if (documents.length === 0) return { ok: true, value: undefined };
    return await config.backend.index(documents);
  } catch (cause) {
    return { ok: false, error: internalError("decision-index indexing failed", cause) };
  }
}

async function queryDecisionsImpl(
  config: DecisionIndexConfig,
  query: DecisionIndexQuery,
): Promise<Result<DecisionIndexPage, KoiError>> {
  const validation = validateQuery(query);
  if (!validation.ok) return validation;

  const filter = buildQueryFilter(query);
  const limit = query.limit !== undefined && query.limit > 0 ? query.limit : DEFAULT_SEARCH_LIMIT;
  try {
    const result = await config.backend.retrieve({
      text: query.text,
      limit,
      ...(filter !== undefined ? { filter } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
    });
    if (!result.ok) return result;

    const hits: DecisionIndexHit[] = [];
    for (const searchResult of result.value.results) {
      const hit = toHit(searchResult);
      if (!hit.ok) return hit;
      hits.push(hit.value);
    }

    return {
      ok: true,
      value: {
        results: hits,
        ...(result.value.total !== undefined ? { total: result.value.total } : {}),
        ...(result.value.cursor !== undefined ? { cursor: result.value.cursor } : {}),
        hasMore: result.value.hasMore,
      },
    };
  } catch (cause) {
    return { ok: false, error: internalError("decision-index query failed", cause) };
  }
}

function validateSnapshot(snapshot: DecisionLedgerSnapshot): Result<void, KoiError> {
  if (snapshot.sessionId.trim().length === 0) {
    return { ok: false, error: validationError("sessionId must not be empty") };
  }
  if (snapshot.integrityLeakCounts.audit !== 0 || snapshot.integrityLeakCounts.report !== 0) {
    return {
      ok: false,
      error: validationError("refusing to index ledger snapshot with integrity leaks"),
    };
  }
  return { ok: true, value: undefined };
}

function validateQuery(query: DecisionIndexQuery): Result<void, KoiError> {
  if (query.text.trim().length === 0) {
    return { ok: false, error: validationError("query text must not be empty") };
  }
  if (query.limit !== undefined && query.limit < 0) {
    return { ok: false, error: validationError("query limit must not be negative") };
  }
  if (query.sessionId !== undefined && query.sessionId.trim().length === 0) {
    return { ok: false, error: validationError("sessionId filter must not be empty") };
  }
  if (query.sessionIds?.some((id) => id.trim().length === 0)) {
    return { ok: false, error: validationError("sessionIds filter must not include empty ids") };
  }
  return { ok: true, value: undefined };
}

async function readPreviousDocumentIds(
  config: DecisionIndexConfig,
  sessionId: string,
): Promise<Result<readonly string[], KoiError>> {
  const result = await config.backend.retrieve({
    text: SESSION_MARKER_CONTENT,
    limit: 1,
    filter: {
      kind: "and",
      filters: [
        { kind: "eq", field: "sessionId", value: sessionId },
        { kind: "eq", field: "sourceKind", value: "session_marker" },
      ],
    },
  });
  if (!result.ok) return result;

  const indexedIds = result.value.results[0]?.data?.indexedDocumentIds;
  if (indexedIds === undefined) return { ok: true, value: [] };
  return { ok: true, value: indexedIds };
}

function buildDecisionDocuments(
  snapshot: DecisionLedgerSnapshot,
  indexedAtMs: number,
): readonly IndexDocument<DecisionIndexDocumentData>[] {
  return [
    ...snapshot.trajectorySteps.map((step) =>
      trajectoryDocument(snapshot.sessionId, step, indexedAtMs),
    ),
    ...snapshot.auditEntries.map((entry, index) =>
      auditDocument(snapshot.sessionId, entry, index, indexedAtMs),
    ),
    ...runReportDocuments(snapshot, indexedAtMs),
  ];
}

function trajectoryDocument(
  sessionId: string,
  step: RichTrajectoryStep,
  indexedAtMs: number,
): IndexDocument<DecisionIndexDocumentData> {
  const title = `${step.kind}:${step.identifier}`;
  const sourceId = String(step.stepIndex);
  return {
    id: decisionDocumentId(sessionId, "trajectory", sourceId),
    content: compactContent([
      title,
      richContentText(step.request),
      richContentText(step.response),
      richContentText(step.error),
      step.outcome,
    ]),
    metadata: {
      sessionId,
      sourceKind: "trajectory",
      source: "trajectory",
      sourceId,
      stepIndex: step.stepIndex,
      timestamp: step.timestamp,
      indexedAtMs,
    },
    data: {
      sessionId,
      sourceKind: "trajectory",
      sourceId,
      title,
      timestamp: step.timestamp,
      stepIndex: step.stepIndex,
    },
  };
}

function auditDocument(
  sessionId: string,
  entry: AuditEntry,
  entryIndex: number,
  indexedAtMs: number,
): IndexDocument<DecisionIndexDocumentData> {
  const sourceId = `${entryIndex}:${entry.timestamp}:${entry.turnIndex}:${entry.kind}:${entry.toolName ?? ""}`;
  const title = `audit:${entry.kind}`;
  return {
    id: decisionDocumentId(sessionId, "audit", sourceId),
    content: compactContent([
      title,
      entry.toolName,
      unknownToText(entry.request),
      unknownToText(entry.response),
      unknownToText(entry.error),
      unknownToText(entry.metadata),
    ]),
    metadata: {
      sessionId,
      sourceKind: "audit",
      source: "audit",
      sourceId,
      auditKind: entry.kind,
      timestamp: entry.timestamp,
      indexedAtMs,
    },
    data: {
      sessionId,
      sourceKind: "audit",
      sourceId,
      title,
      timestamp: entry.timestamp,
      auditKind: entry.kind,
    },
  };
}

function sessionMarkerDocument(
  sessionId: string,
  indexedAtMs: number,
  indexedDocumentIds: readonly string[],
): IndexDocument<DecisionIndexDocumentData> {
  return {
    id: sessionMarkerDocumentId(sessionId),
    content: SESSION_MARKER_CONTENT,
    metadata: {
      sessionId,
      sourceKind: "session_marker",
      source: "session_marker",
      sourceId: sessionId,
      indexedAtMs,
    },
    data: {
      sessionId,
      sourceKind: "session_marker",
      sourceId: sessionId,
      title: "session marker",
      indexedDocumentIds,
    },
  };
}

function runReportDocuments(
  snapshot: DecisionLedgerSnapshot,
  indexedAtMs: number,
): readonly IndexDocument<DecisionIndexDocumentData>[] {
  const report = snapshot.runReport;
  if (report === undefined) return [];

  const sourceKind: DecisionIndexSourceKind = "run_report";
  const baseData = {
    sessionId: snapshot.sessionId,
    sourceKind,
  };
  const baseMetadata = {
    sessionId: snapshot.sessionId,
    sourceKind,
    source: "run_report",
    indexedAtMs,
  };
  const summaryId = `summary:${report.runId}`;
  const summary: IndexDocument<DecisionIndexDocumentData> = {
    id: decisionDocumentId(snapshot.sessionId, "run_report", summaryId),
    content: compactContent([report.summary, report.objective]),
    metadata: {
      ...baseMetadata,
      sourceId: summaryId,
      reportSection: "summary",
      timestamp: report.duration.completedAt,
    },
    data: {
      ...baseData,
      sourceId: summaryId,
      title: "run report summary",
      timestamp: report.duration.completedAt,
      reportSection: "summary",
    },
  };

  const issueDocs = report.issues.map<IndexDocument<DecisionIndexDocumentData>>((issue, index) => {
    const sourceId = `issue:${report.runId}:${index}`;
    const reportSection = "issue";
    return {
      id: decisionDocumentId(snapshot.sessionId, "run_report", sourceId),
      content: compactContent([issue.severity, issue.message, issue.resolution]),
      metadata: {
        ...baseMetadata,
        sourceId,
        reportSection,
        timestamp: report.duration.completedAt,
      },
      data: {
        ...baseData,
        sourceId,
        title: `run report issue:${issue.severity}`,
        timestamp: report.duration.completedAt,
        reportSection,
      },
    };
  });

  const recommendationDocs = report.recommendations.map<IndexDocument<DecisionIndexDocumentData>>(
    (recommendation, index) => {
      const sourceId = `recommendation:${report.runId}:${index}`;
      const reportSection = "recommendation";
      return {
        id: decisionDocumentId(snapshot.sessionId, "run_report", sourceId),
        content: recommendation,
        metadata: {
          ...baseMetadata,
          sourceId,
          reportSection,
          timestamp: report.duration.completedAt,
        },
        data: {
          ...baseData,
          sourceId,
          title: "run report recommendation",
          timestamp: report.duration.completedAt,
          reportSection,
        },
      };
    },
  );

  return [summary, ...issueDocs, ...recommendationDocs];
}

function decisionDocumentId(
  sessionId: string,
  sourceKind: DecisionIndexIndexedSourceKind,
  sourceId: string,
): string {
  return `decision:${encodeURIComponent(sessionId)}:${sourceKind}:${encodeURIComponent(sourceId)}`;
}

function sessionMarkerDocumentId(sessionId: string): string {
  return decisionDocumentId(sessionId, "session_marker", "marker");
}

function buildQueryFilter(query: DecisionIndexQuery): SearchFilter | undefined {
  const filters: SearchFilter[] = [{ kind: "ne", field: "sourceKind", value: "session_marker" }];
  if (query.sessionId !== undefined) {
    filters.push({ kind: "eq", field: "sessionId", value: query.sessionId });
  }
  if (query.sessionIds !== undefined && query.sessionIds.length > 0) {
    filters.push({ kind: "in", field: "sessionId", values: query.sessionIds });
  }
  if (query.sourceKinds !== undefined && query.sourceKinds.length > 0) {
    filters.push({ kind: "in", field: "sourceKind", values: query.sourceKinds });
  }
  if (query.filter !== undefined) {
    filters.push(query.filter);
  }
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { kind: "and", filters };
}

function toHit(result: DecisionIndexSearchResult): Result<DecisionIndexHit, KoiError> {
  const data = result.data;
  const sessionId = data?.sessionId ?? metadataString(result.metadata, "sessionId");
  const sourceKind = data?.sourceKind ?? metadataSourceKind(result.metadata);
  const sourceId = data?.sourceId ?? metadataString(result.metadata, "sourceId");
  if (
    sessionId === undefined ||
    sourceKind === undefined ||
    sourceKind === "session_marker" ||
    sourceId === undefined
  ) {
    return {
      ok: false,
      error: validationError("search result is missing decision-index metadata"),
    };
  }

  return {
    ok: true,
    value: {
      id: result.id,
      score: result.score,
      content: result.content,
      source: result.source,
      sessionId,
      sourceKind,
      sourceId,
      title: data?.title ?? result.id,
      ...(data?.timestamp !== undefined ? { timestamp: data.timestamp } : {}),
      ...(data?.stepIndex !== undefined ? { stepIndex: data.stepIndex } : {}),
      ...(data?.auditKind !== undefined ? { auditKind: data.auditKind } : {}),
      ...(data?.reportSection !== undefined ? { reportSection: data.reportSection } : {}),
      metadata: result.metadata,
    },
  };
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataSourceKind(
  metadata: Readonly<Record<string, unknown>>,
): DecisionIndexIndexedSourceKind | undefined {
  const value = metadata.sourceKind;
  if (value === "trajectory" || value === "audit" || value === "run_report") return value;
  return undefined;
}

function richContentText(content: RichContent | undefined): string | undefined {
  if (content === undefined) return undefined;
  return compactContent([content.text, unknownToText(content.data)]);
}

function unknownToText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function compactContent(parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part.trim().length > 0).join("\n");
}
