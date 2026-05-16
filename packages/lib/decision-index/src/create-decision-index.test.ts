import { describe, expect, test } from "bun:test";
import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  Result,
  RichTrajectoryStep,
  SearchBackend,
  SearchFilter,
  SearchPage,
} from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core";
import { createDecisionIndex } from "./create-decision-index.js";
import type { DecisionIndexDocumentData, DecisionLedgerSnapshot } from "./types.js";

function createInMemoryBackend(): SearchBackend<DecisionIndexDocumentData> & {
  readonly documents: () => readonly IndexDocument<DecisionIndexDocumentData>[];
} {
  const docs = new Map<string, IndexDocument<DecisionIndexDocumentData>>();

  return {
    documents: () => [...docs.values()],
    async index(documents) {
      for (const doc of documents) {
        docs.set(doc.id, doc);
      }
      return { ok: true, value: undefined };
    },
    async remove(ids) {
      for (const id of ids) {
        docs.delete(id);
      }
      return { ok: true, value: undefined };
    },
    async retrieve(query) {
      const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = [...docs.values()].filter(
        (doc) =>
          matchesFilter(doc.metadata ?? {}, query.filter) &&
          terms.every((term) => doc.content.toLowerCase().includes(term)),
      );
      return {
        ok: true,
        value: {
          results: filtered.slice(0, query.limit).map((doc) => ({
            id: doc.id,
            score: 1,
            content: doc.content,
            metadata: doc.metadata ?? {},
            source: "memory",
            ...(doc.data !== undefined ? { data: doc.data } : {}),
          })),
          total: filtered.length,
          hasMore: filtered.length > query.limit,
        },
      };
    },
  };
}

function createErrorBackend(error: KoiError): SearchBackend<DecisionIndexDocumentData> {
  return {
    index: async () => ({ ok: false, error }),
    remove: async () => ({ ok: false, error }),
    retrieve: async (): Promise<Result<SearchPage<DecisionIndexDocumentData>, KoiError>> => ({
      ok: false,
      error,
    }),
  };
}

function matchesFilter(
  metadata: Readonly<Record<string, unknown>>,
  filter: SearchFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  switch (filter.kind) {
    case "eq":
      return metadata[filter.field] === filter.value;
    case "in":
      return filter.values.includes(metadata[filter.field]);
    case "and":
      return filter.filters.every((child) => matchesFilter(metadata, child));
    case "or":
      return filter.filters.some((child) => matchesFilter(metadata, child));
    case "not":
      return !matchesFilter(metadata, filter.filter);
    case "ne":
      return metadata[filter.field] !== filter.value;
    case "gt": {
      const value = metadata[filter.field];
      return typeof value === "number" && value > filter.value;
    }
    case "lt": {
      const value = metadata[filter.field];
      return typeof value === "number" && value < filter.value;
    }
  }
}

function makeStep(index: number, text: string): RichTrajectoryStep {
  return {
    stepIndex: index,
    timestamp: 1_700_000_000_000 + index,
    source: "agent",
    kind: "model_call",
    identifier: "model",
    outcome: "success",
    durationMs: 10,
    request: { text },
    response: { text: `${text} done` },
  };
}

function makeCorrelatedStep(
  index: number,
  text: string,
  correlationId: string,
): RichTrajectoryStep {
  return {
    ...makeStep(index, text),
    metadata: { decisionCorrelationId: correlationId },
  };
}

function makeAudit(session: string, text: string): AuditEntry {
  return {
    schema_version: 1,
    timestamp: 1_700_000_001_000,
    sessionId: session,
    agentId: "agent",
    turnIndex: 1,
    kind: "tool_call",
    toolName: "apply_patch",
    request: { text },
    response: { ok: true },
    durationMs: 12,
  };
}

function makeSnapshot(session: string, text: string): DecisionLedgerSnapshot {
  return {
    sessionId: session,
    trajectorySteps: [makeStep(0, text)],
    auditEntries: [makeAudit(session, text)],
    runReport: {
      agentId: agentId("agent"),
      sessionId: sessionId(session),
      runId: runId(`run-${session}`),
      summary: `${text} summary`,
      duration: {
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        totalTurns: 1,
        totalActions: 1,
        truncated: false,
      },
      actions: [],
      artifacts: [],
      issues: [{ severity: "warning", message: `${text} issue`, turnIndex: 1, resolved: false }],
      cost: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      recommendations: [`${text} recommendation`],
    },
    integrityLeakCounts: { audit: 0, report: 0 },
  };
}

describe("createDecisionIndex", () => {
  test("indexes trajectory, audit, and report decision documents", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend, clock: () => 123 });

    const result = await index.indexSession(makeSnapshot("session-a", "approve deploy"));

    expect(result.ok).toBe(true);
    expect(backend.documents()).toHaveLength(6);
    expect(backend.documents().every((doc) => doc.metadata?.sessionId === "session-a")).toBe(true);
  });

  test("keeps same-turn audit entries as distinct documents", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    const snapshot = {
      ...makeSnapshot("session-a", "approve deploy"),
      auditEntries: [makeAudit("session-a", "first audit"), makeAudit("session-a", "second audit")],
    };

    const result = await index.indexSession(snapshot);

    expect(result.ok).toBe(true);
    const auditDocs = backend.documents().filter((doc) => doc.metadata?.sourceKind === "audit");
    expect(auditDocs).toHaveLength(2);
    expect(new Set(auditDocs.map((doc) => doc.id)).size).toBe(2);
  });

  test("reindexing a session removes stale documents", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    await index.indexSession(makeSnapshot("session-a", "approve deploy"));

    const result = await index.indexSession({
      ...makeSnapshot("session-a", "rollback"),
      auditEntries: [],
      runReport: undefined,
    });

    expect(result.ok).toBe(true);
    const queryResult = await index.queryDecisions({
      text: "approve",
      limit: 10,
      sessionId: "session-a",
    });
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;
    expect(queryResult.value.results).toHaveLength(0);
  });

  test("queries are scoped by session", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    await index.indexSession(makeSnapshot("session-a", "approve deploy"));
    await index.indexSession(makeSnapshot("session-b", "approve rollback"));

    const result = await index.queryDecisions({
      text: "approve",
      limit: 10,
      sessionId: "session-b",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results.every((hit) => hit.sessionId === "session-b")).toBe(true);
  });

  test("indexes decisionCorrelationId from trajectory metadata for outcome-linked search", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    await index.indexSession({
      ...makeSnapshot("session-a", "approve deploy"),
      trajectorySteps: [makeCorrelatedStep(0, "approve deploy", "dcid-a")],
    });
    await index.indexSession({
      ...makeSnapshot("session-b", "approve deploy"),
      trajectorySteps: [makeCorrelatedStep(0, "approve deploy", "dcid-b")],
    });

    const result = await index.queryDecisions({
      text: "approve",
      limit: 10,
      filter: { kind: "eq", field: "decisionCorrelationId", value: "dcid-b" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.sessionId)).toEqual(["session-b"]);
    expect(result.value.results[0]?.metadata.decisionCorrelationId).toBe("dcid-b");
  });

  test("does not index invalid decisionCorrelationId metadata", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    await index.indexSession({
      ...makeSnapshot("session-a", "approve deploy"),
      trajectorySteps: [makeCorrelatedStep(0, "approve deploy", " ".repeat(300))],
    });

    const trajectoryDoc = backend
      .documents()
      .find((doc) => doc.metadata?.sourceKind === "trajectory");

    expect(trajectoryDoc?.metadata?.decisionCorrelationId).toBeUndefined();
    expect(trajectoryDoc?.data?.decisionCorrelationId).toBeUndefined();
  });

  test("hydrates decisionCorrelationId from metadata-only search hits", async () => {
    const backend: SearchBackend<DecisionIndexDocumentData> = {
      index: async () => ({ ok: true, value: undefined }),
      remove: async () => ({ ok: true, value: undefined }),
      retrieve: async () => ({
        ok: true,
        value: {
          results: [
            {
              id: "hit-1",
              score: 1,
              content: "approve deploy",
              source: "metadata-only",
              metadata: {
                sessionId: "session-a",
                sourceKind: "trajectory",
                sourceId: "0",
                decisionCorrelationId: "dcid-meta",
              },
            },
          ],
          hasMore: false,
        },
      }),
    };
    const index = createDecisionIndex({ backend });

    const result = await index.queryDecisions({ text: "approve", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0]?.decisionCorrelationId).toBe("dcid-meta");
  });

  test("propagates backend failures", async () => {
    const error: KoiError = { code: "EXTERNAL", message: "search down", retryable: false };
    const index = createDecisionIndex({ backend: createErrorBackend(error) });

    const indexResult = await index.indexSession(makeSnapshot("session-a", "approve deploy"));
    const queryResult = await index.queryDecisions({ text: "approve", limit: 10 });

    expect(indexResult).toEqual({ ok: false, error });
    expect(queryResult).toEqual({ ok: false, error });
  });

  test("rejects snapshots with integrity leaks", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });
    const snapshot = {
      ...makeSnapshot("session-a", "approve deploy"),
      integrityLeakCounts: { audit: 1, report: 0 },
    };

    const result = await index.indexSession(snapshot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(backend.documents()).toHaveLength(0);
  });

  test("validates empty session and query input", async () => {
    const backend = createInMemoryBackend();
    const index = createDecisionIndex({ backend });

    const indexResult = await index.indexSession(makeSnapshot("", "approve deploy"));
    const queryResult = await index.queryDecisions({ text: "   ", limit: 10 });

    expect(indexResult.ok).toBe(false);
    expect(queryResult.ok).toBe(false);
  });
});
