import type {
  AuditEntry,
  KoiError,
  OutcomeReport,
  Result,
  RichTrajectoryStep,
  RunReport,
} from "@koi/core";

export type DecisionGraphNodeKind =
  | "session"
  | "trajectory_step"
  | "audit_entry"
  | "run_report"
  | "outcome"
  | "issue"
  | "recommendation";

export type DecisionGraphEdgeKind =
  | "contains"
  | "precedes"
  | "corroborates"
  | "produced"
  | "summarizes"
  | "raises"
  | "recommends";

export interface DecisionGraphIntegrityLeakCounts {
  readonly audit: number;
  readonly report: number;
}

export interface DecisionGraphLedgerSnapshot {
  readonly sessionId: string;
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  readonly auditEntries: readonly AuditEntry[];
  readonly outcomeReports?: readonly OutcomeReport[] | undefined;
  readonly runReport?: RunReport | undefined;
  readonly integrityLeakCounts: DecisionGraphIntegrityLeakCounts;
}

export interface DecisionGraphNode {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: DecisionGraphNodeKind;
  readonly label: string;
  readonly timestamp?: number | undefined;
  readonly stepIndex?: number | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface DecisionGraphEdge {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: DecisionGraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface DecisionGraph {
  readonly sessionId: string;
  readonly nodes: readonly DecisionGraphNode[];
  readonly edges: readonly DecisionGraphEdge[];
}

export interface DecisionGraphNeighborsQuery {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly hops?: number | undefined;
  readonly direction?: "incoming" | "outgoing" | "both" | undefined;
}

export interface DecisionGraphSubgraphQuery {
  readonly sessionId: string;
  readonly nodeIds: readonly string[];
  readonly hops?: number | undefined;
}

export interface DecisionGraphStore {
  readonly upsertGraph: (graph: DecisionGraph) => Promise<Result<void, KoiError>>;
  readonly getGraph: (sessionId: string) => Promise<Result<DecisionGraph | undefined, KoiError>>;
  readonly getNeighbors: (
    query: DecisionGraphNeighborsQuery,
  ) => Promise<Result<DecisionGraph, KoiError>>;
  readonly getSubgraph: (
    query: DecisionGraphSubgraphQuery,
  ) => Promise<Result<DecisionGraph, KoiError>>;
}
