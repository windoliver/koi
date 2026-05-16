import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  Result,
  RichTrajectoryStep,
  RunReport,
  SearchBackend,
  SearchFilter,
  SearchResult,
} from "@koi/core";

export interface DecisionIndexIntegrityLeakCounts {
  readonly audit: number;
  readonly report: number;
}

export interface DecisionLedgerSnapshot {
  readonly sessionId: string;
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  readonly auditEntries: readonly AuditEntry[];
  readonly runReport?: RunReport | undefined;
  readonly integrityLeakCounts: DecisionIndexIntegrityLeakCounts;
}

export type DecisionIndexSourceKind = "trajectory" | "audit" | "run_report";
export type DecisionIndexIndexedSourceKind = DecisionIndexSourceKind | "session_marker";

export interface DecisionIndexDocumentData {
  readonly sessionId: string;
  readonly sourceKind: DecisionIndexIndexedSourceKind;
  readonly sourceId: string;
  readonly title: string;
  readonly timestamp?: number | undefined;
  readonly stepIndex?: number | undefined;
  readonly auditKind?: AuditEntry["kind"] | undefined;
  readonly reportSection?: "summary" | "issue" | "recommendation" | undefined;
  readonly indexedDocumentIds?: readonly string[] | undefined;
}

export type DecisionIndexDocument = IndexDocument<DecisionIndexDocumentData>;

export interface DecisionIndexConfig {
  readonly backend: SearchBackend<DecisionIndexDocumentData>;
  readonly clock?: (() => number) | undefined;
}

export interface DecisionIndexSessionFilter {
  readonly sessionId?: string | undefined;
  readonly sessionIds?: readonly string[] | undefined;
}

export interface DecisionIndexQuery extends DecisionIndexSessionFilter {
  readonly text: string;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly minScore?: number | undefined;
  readonly sourceKinds?: readonly DecisionIndexSourceKind[] | undefined;
  readonly filter?: SearchFilter | undefined;
}

export interface DecisionIndexHit {
  readonly id: string;
  readonly score: number;
  readonly content: string;
  readonly source: string;
  readonly sessionId: string;
  readonly sourceKind: DecisionIndexSourceKind;
  readonly sourceId: string;
  readonly title: string;
  readonly timestamp?: number | undefined;
  readonly stepIndex?: number | undefined;
  readonly auditKind?: AuditEntry["kind"] | undefined;
  readonly reportSection?: "summary" | "issue" | "recommendation" | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionIndexPage {
  readonly results: readonly DecisionIndexHit[];
  readonly total?: number | undefined;
  readonly cursor?: string | undefined;
  readonly hasMore: boolean;
}

export interface DecisionIndex {
  readonly indexSession: (snapshot: DecisionLedgerSnapshot) => Promise<Result<void, KoiError>>;
  readonly queryDecisions: (
    query: DecisionIndexQuery,
  ) => Promise<Result<DecisionIndexPage, KoiError>>;
}

export type DecisionIndexSearchResult = SearchResult<DecisionIndexDocumentData>;
