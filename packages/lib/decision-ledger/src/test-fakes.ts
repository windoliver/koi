/**
 * Minimal in-memory fakes of the three sink interfaces, used by unit tests.
 * Not exported from the package barrel — test-only.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core/ecs";
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { ReportStore, RunReport } from "@koi/core/run-report";

export type TrajectoryReader = Pick<TrajectoryDocumentStore, "getDocument">;

export function createFakeTrajectoryReader(
  records: ReadonlyMap<string, readonly RichTrajectoryStep[]>,
): TrajectoryReader {
  return {
    getDocument: async (docId) => records.get(docId) ?? [],
  };
}

export function createThrowingTrajectoryReader(error: Error): TrajectoryReader {
  return {
    getDocument: async () => {
      throw error;
    },
  };
}

export interface FakeAuditSinkOptions {
  readonly entries?: ReadonlyMap<string, readonly AuditEntry[]>;
  readonly includeQuery?: boolean;
  readonly queryThrows?: Error;
}

export function createFakeAuditSink(options: FakeAuditSinkOptions = {}): AuditSink {
  const { entries, includeQuery = true, queryThrows } = options;
  const base: { log: AuditSink["log"] } = {
    log: async () => {},
  };
  if (!includeQuery) {
    return base as AuditSink;
  }
  const query: NonNullable<AuditSink["query"]> = async (sessionId) => {
    if (queryThrows) {
      throw queryThrows;
    }
    return entries?.get(sessionId) ?? [];
  };
  return { ...base, query } satisfies AuditSink;
}

export function createFakeReportStore(
  reports: ReadonlyMap<string, readonly RunReport[]>,
  options: { readonly throws?: Error } = {},
): ReportStore {
  return {
    put: () => {},
    getBySession: async (sessionId) => {
      if (options.throws) {
        throw options.throws;
      }
      return reports.get(sessionId) ?? [];
    },
  };
}

let stepCounter = 0;

export function makeTrajectoryStep(
  overrides: Partial<RichTrajectoryStep> = {},
): RichTrajectoryStep {
  stepCounter += 1;
  return {
    stepIndex: stepCounter,
    timestamp: 1_700_000_000_000 + stepCounter,
    source: "agent",
    kind: "model_call",
    identifier: `step-${stepCounter}`,
    outcome: "success",
    durationMs: 10,
    ...overrides,
  };
}

let auditCounter = 0;

export function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  auditCounter += 1;
  return {
    schema_version: 1,
    timestamp: 1_700_000_000_000 + auditCounter,
    sessionId: "default-session",
    agentId: "agent-a",
    turnIndex: auditCounter,
    kind: "tool_call",
    durationMs: 5,
    ...overrides,
  };
}

export function resetFakeCounters(): void {
  stepCounter = 0;
  auditCounter = 0;
}

export interface MakeRunReportOverrides extends Partial<RunReport> {
  /** Convenience: passes a plain string, branded inside the helper. */
  readonly sessionIdOverride?: string;
}

export function makeRunReport(overrides: MakeRunReportOverrides = {}): RunReport {
  const baseDuration = {
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    durationMs: 1_000,
    totalTurns: 1,
    totalActions: 0,
    truncated: false,
  } as const;
  const { sessionIdOverride, ...rest } = overrides;
  return {
    agentId: agentId("agent-a"),
    sessionId: sessionId(sessionIdOverride ?? "default-session"),
    runId: runId("run-1"),
    summary: "",
    duration: baseDuration,
    actions: [],
    artifacts: [],
    issues: [],
    cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    recommendations: [],
    ...rest,
  };
}
