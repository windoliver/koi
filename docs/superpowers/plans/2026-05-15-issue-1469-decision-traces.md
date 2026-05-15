# Issue 1469 Decision Traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish issue #1469 by hardening Nexus trajectory persistence, adding a cross-session decision search index, and materializing decision artifacts into a queryable graph.

**Architecture:** Preserve the shipped `@koi/runtime` trajectory persistence and `@koi/decision-ledger` per-session reader. Add two focused L2 packages: `@koi/decision-index` maps ledgers/outcomes into the L0 `SearchBackend`; `@koi/decision-graph` maps ledgers/outcomes into a typed graph store with in-memory, Nexus VFS, and Nexus graph HTTP adapters. Runtime wires these packages only through optional factories and injected dependencies.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup, Biome, existing Koi L0 contracts, existing `@koi/search-nexus` and `@koi/nexus-client` transports.

---

## File Structure

- Modify `packages/meta/runtime/src/trajectory/nexus-delegate.test.ts` for restart-survival coverage.
- Create `packages/lib/decision-index/*` for cross-session search projection.
- Modify root `tsconfig.json` only when the existing project-reference list has an entry for every `packages/lib/*` L2 package; add `packages/lib/decision-index` in that same list.
- Modify `packages/meta/runtime/package.json`, `packages/meta/runtime/src/types.ts`, `packages/meta/runtime/src/index.ts`, and `packages/meta/runtime/src/create-runtime.ts` for optional factories.
- Create `packages/lib/decision-graph/*` for graph types, materialization, in-memory store, Nexus VFS store, Nexus graph HTTP store.
- Update `docs/L2/decision-ledger.md`, add `docs/L2/decision-index.md`, add `docs/L2/decision-graph.md`, update `docs/L3/runtime.md`.
- Add standalone golden coverage in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`.

## Task 0: Baseline Build Inputs

**Files:**
- Read-only: `packages/kernel/core/package.json`
- Read-only: `packages/lib/decision-ledger/package.json`
- Read-only: `packages/lib/search-nexus/package.json`

- [ ] **Step 1: Confirm branch and clean tree**

Run:

```bash
git branch --show-current
git status --short
```

Expected:

```text
codex/issue-1469-decision-traces
```

`git status --short` should be clean except for files intentionally changed by the current task.

- [ ] **Step 2: Install dependencies**

Run:

```bash
bun install --frozen-lockfile
```

Expected: install succeeds without modifying `bun.lock`.

- [ ] **Step 3: Build core before package tests**

Run:

```bash
bun run --cwd packages/kernel/core build
```

Expected: `dist/` exists for `@koi/core`, because workspace package exports point at `dist`.

## Task 1: Harden Nexus Trajectory Restart Coverage

**Files:**
- Modify: `packages/meta/runtime/src/trajectory/nexus-delegate.test.ts`

- [ ] **Step 1: Write the failing restart-survival test**

Add this test near the existing `write and read round-trip` coverage:

```ts
test("document survives a fresh delegate instance sharing the same Nexus transport", async () => {
  const firstDelegate = createNexusAtifDelegate({ transport });
  await firstDelegate.write("restart-doc", DOC);

  const secondDelegate = createNexusAtifDelegate({ transport });
  const result = await secondDelegate.read("restart-doc");

  expect(result?.session_id).toBe("test-session");
  expect(result?.steps).toHaveLength(1);
  expect(result?.steps[0]?.message).toBe("hello");
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
bun test packages/meta/runtime/src/trajectory/nexus-delegate.test.ts
```

Expected: If the behavior is already implemented, the new test passes. If it fails, the failure must show the fresh delegate cannot load the stored document.

- [ ] **Step 3: Implement only if red**

If the test fails, fix `packages/meta/runtime/src/trajectory/nexus-delegate.ts` so `read()` reconstructs documents from persisted metadata and step chunks without relying on process-local state.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test packages/meta/runtime/src/trajectory/nexus-delegate.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/meta/runtime/src/trajectory/nexus-delegate.test.ts packages/meta/runtime/src/trajectory/nexus-delegate.ts
git commit -m "test(runtime): cover Nexus trajectory restart persistence"
```

If no production change was required, only stage the test file.

## Task 2: Scaffold `@koi/decision-index`

**Files:**
- Create: `packages/lib/decision-index/package.json`
- Create: `packages/lib/decision-index/tsconfig.json`
- Create: `packages/lib/decision-index/tsup.config.ts`
- Create: `packages/lib/decision-index/src/index.ts`
- Create: `packages/lib/decision-index/src/types.ts`
- Create: `packages/lib/decision-index/src/errors.ts`
- Create: `packages/lib/decision-index/src/test-fakes.ts`
- Modify: root `tsconfig.json` if project references require it

- [ ] **Step 1: Create package metadata**

Create `packages/lib/decision-index/package.json`:

```json
{
  "name": "@koi/decision-index",
  "description": "Cross-session decision search projection over ledgers and outcome reports",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "scripts": {
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  }
}
```

- [ ] **Step 2: Copy package configs from `@koi/decision-ledger`**

Copy the structure of:

```text
packages/lib/decision-ledger/tsconfig.json
packages/lib/decision-ledger/tsup.config.ts
```

Keep the same package-relative structure as `@koi/decision-ledger`; the package-specific values are the folder path and package name.

- [ ] **Step 3: Add public type skeleton**

Create `packages/lib/decision-index/src/types.ts`:

```ts
import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  OutcomeReport,
  Result,
  RichTrajectoryStep,
  RunReport,
  SearchBackend,
  SearchPage,
} from "@koi/core";

export type DecisionIndexDocumentKind =
  | "decision-step"
  | "audit-entry"
  | "run-report"
  | "outcome-report"
  | "session-summary";

export interface DecisionIndexRecord {
  readonly schemaVersion: 1;
  readonly kind: DecisionIndexDocumentKind;
  readonly sessionId: string;
  readonly id: string;
  readonly content: string;
  readonly timestampMs?: number | undefined;
  readonly decisionCorrelationId?: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionIndexWriteSummary {
  readonly indexedCount: number;
  readonly removedCount: number;
}

export interface DecisionLedgerSnapshot {
  readonly sessionId: string;
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  readonly auditEntries: readonly AuditEntry[];
  readonly runReport?: RunReport | undefined;
  readonly sources: {
    readonly trajectory: { readonly state: string };
    readonly audit: { readonly state: string };
    readonly report: { readonly state: string };
  };
  readonly integrityLeakCounts: {
    readonly audit: number;
    readonly report: number;
  };
}

export interface IndexLedgerInput {
  readonly ledger: DecisionLedgerSnapshot;
  readonly outcomes?: readonly OutcomeReport[] | undefined;
}

export interface IndexOutcomeInput {
  readonly sessionId: string;
  readonly outcome: OutcomeReport;
}

export interface DecisionSearchQuery {
  readonly text: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly minScore?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly kind?: DecisionIndexDocumentKind | undefined;
  readonly decisionCorrelationId?: string | undefined;
}

export interface DecisionIndexConfig {
  readonly searchBackend: SearchBackend<DecisionIndexRecord>;
}

export interface DecisionIndex {
  readonly indexLedger: (
    input: IndexLedgerInput,
  ) => Promise<Result<DecisionIndexWriteSummary, KoiError>>;
  readonly indexOutcome: (
    input: IndexOutcomeInput,
  ) => Promise<Result<DecisionIndexWriteSummary, KoiError>>;
  readonly removeSession: (sessionId: string) => Promise<Result<void, KoiError>>;
  readonly search: (
    query: DecisionSearchQuery,
  ) => Promise<Result<SearchPage<DecisionIndexRecord>, KoiError>>;
}

export type DecisionIndexDocument = IndexDocument<DecisionIndexRecord>;
```

- [ ] **Step 4: Add barrel exports**

Create `packages/lib/decision-index/src/index.ts`:

```ts
export { createDecisionIndex } from "./decision-index.js";
export type {
  DecisionIndex,
  DecisionIndexConfig,
  DecisionIndexDocument,
  DecisionIndexDocumentKind,
  DecisionIndexRecord,
  DecisionIndexWriteSummary,
  DecisionSearchQuery,
  IndexLedgerInput,
  IndexOutcomeInput,
} from "./types.js";
```

- [ ] **Step 5: Verify scaffold type failure is expected**

Run:

```bash
bun test packages/lib/decision-index
```

Expected: fails because `./decision-index.js` is not implemented yet. This confirms the package is visible to Bun.

## Task 3: Implement Decision Index Projection With TDD

**Files:**
- Create: `packages/lib/decision-index/src/decision-index.test.ts`
- Create: `packages/lib/decision-index/src/decision-index.ts`
- Create: `packages/lib/decision-index/src/projection.ts`
- Create: `packages/lib/decision-index/src/search-filter.ts`
- Create: `packages/lib/decision-index/src/errors.ts`
- Create: `packages/lib/decision-index/src/test-fakes.ts`

- [ ] **Step 1: Write failing projection test**

Create `packages/lib/decision-index/src/decision-index.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { decisionCorrelationId } from "@koi/core";
import { createDecisionIndex } from "./decision-index.js";
import { createFakeSearchBackend, makeLedger, makeOutcome } from "./test-fakes.js";

describe("createDecisionIndex", () => {
  test("indexes deterministic session summary, trajectory, audit, report, and outcome documents", async () => {
    const backend = createFakeSearchBackend();
    const index = createDecisionIndex({ searchBackend: backend });
    const ledger = makeLedger({
      sessionId: "s-1",
      decisionCorrelationId: "dcid-1",
    });
    const outcome = makeOutcome({
      correlationId: decisionCorrelationId("dcid-1"),
      description: "Customer accepted the discount",
    });

    const result = await index.indexLedger({ ledger, outcomes: [outcome] });

    expect(result.ok).toBe(true);
    expect(backend.indexed.map((doc) => doc.id)).toEqual([
      "session:s-1:summary",
      "session:s-1:step:1",
      "session:s-1:audit:0",
      "session:s-1:report:1700000010000",
      "outcome:dcid-1",
    ]);
    expect(backend.indexed[1]?.data?.decisionCorrelationId).toBe("dcid-1");
    expect(backend.indexed[4]?.content).toContain("Customer accepted the discount");
  });
});
```

- [ ] **Step 2: Run red**

Run:

```bash
bun test packages/lib/decision-index/src/decision-index.test.ts
```

Expected: fails because implementation files do not exist.

- [ ] **Step 3: Implement test fakes**

Create `packages/lib/decision-index/src/test-fakes.ts`:

```ts
import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  OutcomeReport,
  Result,
  RichTrajectoryStep,
  RunReport,
  SearchBackend,
  SearchPage,
  SearchQuery,
} from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core/ecs";
import type { DecisionIndexRecord, DecisionLedgerSnapshot } from "./types.js";

export interface FakeSearchBackend extends SearchBackend<DecisionIndexRecord> {
  readonly indexed: readonly IndexDocument<DecisionIndexRecord>[];
  readonly removed: readonly string[];
  readonly queries: readonly SearchQuery[];
}

export function createFakeSearchBackend(): FakeSearchBackend {
  const indexed: IndexDocument<DecisionIndexRecord>[] = [];
  const removed: string[] = [];
  const queries: SearchQuery[] = [];
  return {
    get indexed() {
      return indexed;
    },
    get removed() {
      return removed;
    },
    get queries() {
      return queries;
    },
    index: async (documents) => {
      indexed.push(...documents);
      return { ok: true, value: undefined };
    },
    remove: async (ids) => {
      removed.push(...ids);
      return { ok: true, value: undefined };
    },
    retrieve: async (query) => {
      queries.push(query);
      const page: SearchPage<DecisionIndexRecord> = { results: [], hasMore: false };
      return { ok: true, value: page };
    },
  };
}

export function createFailingSearchBackend(error: KoiError): SearchBackend<DecisionIndexRecord> {
  return {
    index: async (): Promise<Result<void, KoiError>> => ({ ok: false, error }),
    remove: async (): Promise<Result<void, KoiError>> => ({ ok: false, error }),
    retrieve: async (): Promise<Result<SearchPage<DecisionIndexRecord>, KoiError>> => ({
      ok: false,
      error,
    }),
  };
}

export function makeLedger(options: {
  readonly sessionId: string;
  readonly decisionCorrelationId?: string | undefined;
}): DecisionLedgerSnapshot {
  return {
    sessionId: options.sessionId,
    trajectorySteps: [
      {
        stepIndex: 1,
        timestamp: 1_700_000_000_001,
        source: "agent",
        kind: "tool_call",
        identifier: "discount_tool",
        outcome: "success",
        metadata:
          options.decisionCorrelationId !== undefined
            ? { decisionCorrelationId: options.decisionCorrelationId }
            : {},
      },
    ],
    auditEntries: [
      {
        schema_version: 1,
        timestamp: 1_700_000_000_002,
        sessionId: options.sessionId,
        agentId: "agent-a",
        turnIndex: 1,
        kind: "tool_call",
      },
    ],
    runReport: {
      agentId: agentId("agent-a"),
      sessionId: sessionId(options.sessionId),
      runId: runId("run-1"),
      summary: "Discount decision completed",
      duration: {
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_010_000,
        durationMs: 10_000,
        totalTurns: 1,
        totalActions: 1,
        truncated: false,
      },
      actions: [],
      artifacts: [],
      issues: [],
      cost: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      recommendations: [],
    },
    sources: {
      trajectory: { state: "present-unverified" },
      audit: { state: "present" },
      report: { state: "present" },
    },
    integrityLeakCounts: { audit: 0, report: 0 },
    trajectoryTrustModel: "store-authoritative",
    allLanesFieldVerified: false,
  };
}

export function makeOutcome(overrides: Partial<OutcomeReport> = {}): OutcomeReport {
  return {
    correlationId: overrides.correlationId ?? ("dcid-default" as OutcomeReport["correlationId"]),
    outcome: overrides.outcome ?? "positive",
    metrics: overrides.metrics ?? {},
    description: overrides.description ?? "Outcome recorded",
    reportedBy: overrides.reportedBy ?? "test",
    timestamp: overrides.timestamp ?? 1_700_000_020_000,
    metadata: overrides.metadata,
  };
}
```

- [ ] **Step 4: Implement errors**

Create `packages/lib/decision-index/src/errors.ts`:

```ts
import type { KoiError } from "@koi/core";

export function validationError(message: string): KoiError {
  return { code: "VALIDATION", message, retryable: false };
}
```

- [ ] **Step 5: Implement projection**

Create `packages/lib/decision-index/src/projection.ts` with pure functions:

```ts
import type { OutcomeReport } from "@koi/core";
import type {
  DecisionIndexDocument,
  DecisionIndexDocumentKind,
  DecisionLedgerSnapshot,
  DecisionIndexRecord,
} from "./types.js";

function maybeCorrelation(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = metadata?.decisionCorrelationId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function document(
  kind: DecisionIndexDocumentKind,
  id: string,
  sessionId: string,
  content: string,
  metadata: Readonly<Record<string, unknown>>,
  timestampMs?: number,
  decisionCorrelationId?: string,
): DecisionIndexDocument {
  const record: DecisionIndexRecord = {
    schemaVersion: 1,
    kind,
    sessionId,
    id,
    content,
    metadata: { kind, sessionId, ...metadata },
    ...(timestampMs !== undefined ? { timestampMs } : {}),
    ...(decisionCorrelationId !== undefined ? { decisionCorrelationId } : {}),
  };
  return { id, content, metadata: record.metadata, data: record };
}

export function mapLedgerToDecisionIndexDocuments(
  ledger: DecisionLedgerSnapshot,
  outcomes: readonly OutcomeReport[] = [],
): readonly DecisionIndexDocument[] {
  const sessionId = ledger.sessionId;
  const summary = document(
    "session-summary",
    `session:${sessionId}:summary`,
    sessionId,
    `Session ${sessionId} trajectory ${ledger.trajectorySteps.length} audit ${ledger.auditEntries.length} report ${ledger.runReport?.summary ?? ""}`,
    {
      trajectorySourceState: ledger.sources.trajectory.state,
      auditSourceState: ledger.sources.audit.state,
      reportSourceState: ledger.sources.report.state,
      integrityLeakAudit: ledger.integrityLeakCounts.audit,
      integrityLeakReport: ledger.integrityLeakCounts.report,
    },
  );

  const steps = ledger.trajectorySteps.map((step) => {
    const correlationId = maybeCorrelation(step.metadata);
    return document(
      "decision-step",
      `session:${sessionId}:step:${step.stepIndex}`,
      sessionId,
      `${step.kind} ${step.identifier} ${step.outcome ?? ""}`,
      {
        stepIndex: step.stepIndex,
        stepKind: step.kind,
        identifier: step.identifier,
        ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
      },
      step.timestamp,
      correlationId,
    );
  });

  const audit = ledger.auditEntries.map((entry, index) =>
    document(
      "audit-entry",
      `session:${sessionId}:audit:${index}`,
      sessionId,
      `${entry.kind} ${entry.agentId} turn ${entry.turnIndex}`,
      { auditKind: entry.kind, turnIndex: entry.turnIndex },
      entry.timestamp,
    ),
  );

  const report =
    ledger.runReport !== undefined
      ? [
          document(
            "run-report",
            `session:${sessionId}:report:${ledger.runReport.duration.completedAt}`,
            sessionId,
            ledger.runReport.summary,
            { runId: ledger.runReport.runId },
            ledger.runReport.duration.completedAt,
          ),
        ]
      : [];

  const outcomeDocuments = outcomes.map((outcome) =>
    mapOutcomeToDecisionIndexDocument(sessionId, outcome),
  );

  return [summary, ...steps, ...audit, ...report, ...outcomeDocuments];
}

export function mapOutcomeToDecisionIndexDocument(
  sessionId: string,
  outcome: OutcomeReport,
): DecisionIndexDocument {
  const correlationId = String(outcome.correlationId);
  return document(
    "outcome-report",
    `outcome:${correlationId}`,
    sessionId,
    `${outcome.outcome} ${outcome.description}`,
    { outcome: outcome.outcome, reportedBy: outcome.reportedBy },
    outcome.timestamp,
    correlationId,
  );
}

export function computeSessionDocumentIds(ledger: DecisionLedgerSnapshot): readonly string[] {
  return mapLedgerToDecisionIndexDocuments(ledger).map((doc) => doc.id);
}
```

- [ ] **Step 6: Implement search filter mapping**

Create `packages/lib/decision-index/src/search-filter.ts`:

```ts
import type { SearchFilter, SearchQuery } from "@koi/core";
import type { DecisionSearchQuery } from "./types.js";

function and(filters: readonly SearchFilter[]): SearchFilter | undefined {
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { kind: "and", filters };
}

export function mapDecisionSearchQuery(query: DecisionSearchQuery): SearchQuery {
  const filters: SearchFilter[] = [];
  if (query.sessionId !== undefined) {
    filters.push({ kind: "eq", field: "sessionId", value: query.sessionId });
  }
  if (query.kind !== undefined) {
    filters.push({ kind: "eq", field: "kind", value: query.kind });
  }
  if (query.decisionCorrelationId !== undefined) {
    filters.push({
      kind: "eq",
      field: "decisionCorrelationId",
      value: query.decisionCorrelationId,
    });
  }
  return {
    text: query.text,
    limit: query.limit,
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
    ...(and(filters) !== undefined ? { filter: and(filters) } : {}),
  };
}
```

- [ ] **Step 7: Implement factory**

Create `packages/lib/decision-index/src/decision-index.ts`:

```ts
import type { Result } from "@koi/core";
import { validationError } from "./errors.js";
import { mapLedgerToDecisionIndexDocuments, mapOutcomeToDecisionIndexDocument } from "./projection.js";
import { mapDecisionSearchQuery } from "./search-filter.js";
import type {
  DecisionIndex,
  DecisionIndexConfig,
  DecisionIndexWriteSummary,
} from "./types.js";

export function createDecisionIndex(config: DecisionIndexConfig): DecisionIndex {
  return {
    async indexLedger(input) {
      if (input.ledger.sessionId.length === 0) {
        return { ok: false, error: validationError("sessionId must not be empty") };
      }
      const docs = mapLedgerToDecisionIndexDocuments(input.ledger, input.outcomes ?? []);
      const result = await config.searchBackend.index(docs);
      if (!result.ok) return result;
      return { ok: true, value: { indexedCount: docs.length, removedCount: 0 } };
    },
    async indexOutcome(input) {
      if (input.sessionId.length === 0) {
        return { ok: false, error: validationError("sessionId must not be empty") };
      }
      const doc = mapOutcomeToDecisionIndexDocument(input.sessionId, input.outcome);
      const result = await config.searchBackend.index([doc]);
      if (!result.ok) return result;
      return { ok: true, value: { indexedCount: 1, removedCount: 0 } };
    },
    async removeSession(sessionId): Promise<Result<void, import("@koi/core").KoiError>> {
      if (sessionId.length === 0) {
        return { ok: false, error: validationError("sessionId must not be empty") };
      }
      return config.searchBackend.remove([`session:${sessionId}:summary`]);
    },
    async search(query) {
      const hasStructuredFilter =
        query.sessionId !== undefined ||
        query.kind !== undefined ||
        query.decisionCorrelationId !== undefined;
      if (query.text.length === 0 && !hasStructuredFilter) {
        return {
          ok: false,
          error: validationError("empty decision search requires at least one structured filter"),
        };
      }
      return config.searchBackend.retrieve(mapDecisionSearchQuery(query));
    },
  };
}
```

`removeSession()` removes `session:{sessionId}:summary`. `SearchBackend` has no enumeration primitive, so full session replacement is handled by idempotent `indexLedger()` writes for deterministic document IDs.

- [ ] **Step 8: Verify green**

Run:

```bash
bun test packages/lib/decision-index/src/decision-index.test.ts
bun run --cwd packages/lib/decision-index typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 9: Add search and error tests**

Extend `decision-index.test.ts` with:

```ts
test("search maps structured filters to SearchBackend query", async () => {
  const backend = createFakeSearchBackend();
  const index = createDecisionIndex({ searchBackend: backend });

  const result = await index.search({
    text: "",
    limit: 10,
    sessionId: "s-1",
    kind: "decision-step",
    decisionCorrelationId: "dcid-1",
  });

  expect(result.ok).toBe(true);
  expect(backend.queries[0]?.filter).toEqual({
    kind: "and",
    filters: [
      { kind: "eq", field: "sessionId", value: "s-1" },
      { kind: "eq", field: "kind", value: "decision-step" },
      { kind: "eq", field: "decisionCorrelationId", value: "dcid-1" },
    ],
  });
});

test("rejects empty unfiltered search", async () => {
  const index = createDecisionIndex({ searchBackend: createFakeSearchBackend() });
  const result = await index.search({ text: "", limit: 10 });
  expect(result.ok).toBe(false);
});

test("propagates backend index failures", async () => {
  const index = createDecisionIndex({
    searchBackend: createFailingSearchBackend({
      code: "EXTERNAL",
      message: "search down",
      retryable: true,
    }),
  });
  const result = await index.indexLedger({ ledger: makeLedger({ sessionId: "s-1" }) });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 10: Verify package**

Run:

```bash
bun test packages/lib/decision-index
bun run --cwd packages/lib/decision-index build
```

Expected: pass.

- [ ] **Step 11: Commit**

Run:

```bash
git add packages/lib/decision-index tsconfig.json package.json bun.lock
git commit -m "feat(decision-index): add cross-session decision search projection"
```

Only stage root files if they actually changed.

## Task 4: Wire Decision Index Into Runtime

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/src/types.ts`
- Modify: `packages/meta/runtime/src/create-runtime.ts`
- Modify: `packages/meta/runtime/src/index.ts`
- Modify: `packages/meta/runtime/src/create-runtime.test.ts`

- [ ] **Step 1: Write failing runtime factory tests**

Add tests to `packages/meta/runtime/src/create-runtime.test.ts` near decision-ledger tests:

```ts
test("createDecisionIndex is undefined without a trajectory store", () => {
  const runtime = createRuntime();
  expect(runtime.createDecisionIndex).toBeUndefined();
});

test("createDecisionIndex uses injected search backend when trajectory store exists", () => {
  const runtime = createRuntime({
    trajectoryDir: `/tmp/koi-decision-index-${Date.now()}`,
  });
  const searchBackend = {
    index: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
    retrieve: async () => ({ ok: true, value: { results: [], hasMore: false } }),
  } satisfies import("@koi/core").SearchBackend<
    import("@koi/decision-index").DecisionIndexRecord
  >;

  const index = runtime.createDecisionIndex?.({ searchBackend });
  expect(index).toBeDefined();
});
```

- [ ] **Step 2: Run red**

Run:

```bash
bun run --cwd packages/kernel/core build
bun run --cwd packages/lib/decision-index build
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: fails because runtime types/factory do not expose `createDecisionIndex`.

- [ ] **Step 3: Add runtime dependency**

Add to `packages/meta/runtime/package.json` dependencies:

```json
"@koi/decision-index": "workspace:*"
```

- [ ] **Step 4: Extend RuntimeHandle type**

In `packages/meta/runtime/src/types.ts`, import the types and add:

```ts
readonly createDecisionIndex:
  | ((options: {
      readonly searchBackend: SearchBackend<DecisionIndexRecord>;
    }) => DecisionIndex)
  | undefined;
```

Use `import type` for `DecisionIndex`, `DecisionIndexRecord`, and `SearchBackend`.

- [ ] **Step 5: Implement factory in `create-runtime.ts`**

Import:

```ts
import { createDecisionIndex } from "@koi/decision-index";
import type { DecisionIndexRecord } from "@koi/decision-index";
import type { SearchBackend } from "@koi/core";
```

Add to the runtime handle object:

```ts
createDecisionIndex:
  trajectoryStore !== undefined
    ? (options: { readonly searchBackend: SearchBackend<DecisionIndexRecord> }) =>
        createDecisionIndex({ searchBackend: options.searchBackend })
    : undefined,
```

- [ ] **Step 6: Re-export types**

In `packages/meta/runtime/src/index.ts` add type exports:

```ts
export type {
  DecisionIndex,
  DecisionIndexConfig,
  DecisionIndexRecord,
  DecisionSearchQuery,
} from "@koi/decision-index";
```

- [ ] **Step 7: Verify green**

Run:

```bash
bun run --cwd packages/meta/runtime typecheck
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/meta/runtime package.json bun.lock
git commit -m "feat(runtime): expose decision index factory"
```

Only stage root files if changed.

## Task 5: Scaffold `@koi/decision-graph`

**Files:**
- Create: `packages/lib/decision-graph/package.json`
- Create: `packages/lib/decision-graph/tsconfig.json`
- Create: `packages/lib/decision-graph/tsup.config.ts`
- Create: `packages/lib/decision-graph/src/index.ts`
- Create: `packages/lib/decision-graph/src/types.ts`
- Create: `packages/lib/decision-graph/src/errors.ts`

- [ ] **Step 1: Create package metadata**

Create `packages/lib/decision-graph/package.json`:

```json
{
  "name": "@koi/decision-graph",
  "description": "Decision artifact graph materialization and traversal",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  },
  "scripts": {
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  }
}
```

- [ ] **Step 2: Copy configs**

Copy `tsconfig.json` and `tsup.config.ts` from `packages/lib/decision-index` after Task 3.

- [ ] **Step 3: Add graph types**

Create `packages/lib/decision-graph/src/types.ts` with the public types from the design:

```ts
import type { AuditEntry, KoiError, OutcomeReport, Result, RichTrajectoryStep, RunReport } from "@koi/core";

export type DecisionGraphNodeKind =
  | "session"
  | "trajectory-step"
  | "audit-entry"
  | "run-report"
  | "outcome-report"
  | "entity";

export type DecisionGraphEdgeKind =
  | "contains"
  | "approved"
  | "denied"
  | "reported-outcome"
  | "mentions-entity"
  | "correlates-with";

export interface DecisionGraphNode {
  readonly id: string;
  readonly kind: DecisionGraphNodeKind;
  readonly label: string;
  readonly sessionId?: string | undefined;
  readonly timestampMs?: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionGraphEdge {
  readonly id: string;
  readonly kind: DecisionGraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionSubgraph {
  readonly nodes: readonly DecisionGraphNode[];
  readonly edges: readonly DecisionGraphEdge[];
}

export interface DecisionGraphWriteSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface DecisionGraphLedgerSnapshot {
  readonly sessionId: string;
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  readonly auditEntries: readonly AuditEntry[];
  readonly runReport?: RunReport | undefined;
  readonly sources: {
    readonly trajectory: { readonly state: string };
    readonly audit: { readonly state: string };
    readonly report: { readonly state: string };
  };
}

export interface MaterializeLedgerGraphInput {
  readonly ledger: DecisionGraphLedgerSnapshot;
  readonly outcomes?: readonly OutcomeReport[] | undefined;
}

export interface DecisionGraphNeighborsQuery {
  readonly nodeId: string;
  readonly direction: "in" | "out" | "both";
  readonly depth: number;
  readonly edgeKinds?: readonly DecisionGraphEdgeKind[] | undefined;
}

export interface DecisionGraphPathQuery {
  readonly from: string;
  readonly to: string;
  readonly maxDepth: number;
}

export interface DecisionGraphStore {
  readonly upsert: (
    nodes: readonly DecisionGraphNode[],
    edges: readonly DecisionGraphEdge[],
  ) => Promise<Result<DecisionGraphWriteSummary, KoiError>>;
  readonly neighbors: (
    query: DecisionGraphNeighborsQuery,
  ) => Promise<Result<DecisionSubgraph, KoiError>>;
  readonly path: (query: DecisionGraphPathQuery) => Promise<Result<DecisionSubgraph, KoiError>>;
}
```

- [ ] **Step 4: Add exports**

Create `packages/lib/decision-graph/src/index.ts`:

```ts
export { createInMemoryDecisionGraphStore } from "./in-memory-store.js";
export { materializeLedgerGraph } from "./materialize.js";
export { createNexusRecordStoreDecisionGraphStore } from "./nexus-record-store.js";
export { createNexusVfsDecisionGraphStore } from "./nexus-vfs-store.js";
export type {
  DecisionGraphEdge,
  DecisionGraphEdgeKind,
  DecisionGraphLedgerSnapshot,
  DecisionGraphNeighborsQuery,
  DecisionGraphNode,
  DecisionGraphNodeKind,
  DecisionGraphPathQuery,
  DecisionGraphStore,
  DecisionGraphWriteSummary,
  DecisionSubgraph,
  MaterializeLedgerGraphInput,
} from "./types.js";
```

- [ ] **Step 5: Run red**

Run:

```bash
bun test packages/lib/decision-graph
```

Expected: fails because exported implementation modules do not exist.

## Task 6: Implement Decision Graph Materializer and In-Memory Store

**Files:**
- Create: `packages/lib/decision-graph/src/materialize.test.ts`
- Create: `packages/lib/decision-graph/src/materialize.ts`
- Create: `packages/lib/decision-graph/src/in-memory-store.test.ts`
- Create: `packages/lib/decision-graph/src/in-memory-store.ts`
- Create: `packages/lib/decision-graph/src/test-fakes.ts`
- Create: `packages/lib/decision-graph/src/errors.ts`

- [ ] **Step 1: Write materializer failing test**

Create `materialize.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decisionCorrelationId } from "@koi/core";
import { materializeLedgerGraph } from "./materialize.js";
import { makeLedger, makeOutcome } from "./test-fakes.js";

describe("materializeLedgerGraph", () => {
  test("creates session, step, audit, report, outcome nodes and correlation edge", () => {
    const ledger = makeLedger({ sessionId: "s-1", decisionCorrelationId: "dcid-1" });
    const outcome = makeOutcome({ correlationId: decisionCorrelationId("dcid-1") });

    const graph = materializeLedgerGraph({ ledger, outcomes: [outcome] });

    expect(graph.nodes.map((n) => n.id)).toContain("session:s-1");
    expect(graph.nodes.map((n) => n.id)).toContain("session:s-1:step:1");
    expect(graph.nodes.map((n) => n.id)).toContain("outcome:dcid-1");
    expect(graph.edges).toContainEqual({
      id: "edge:session:s-1:step:1:correlates-with:outcome:dcid-1",
      kind: "correlates-with",
      from: "session:s-1:step:1",
      to: "outcome:dcid-1",
      metadata: { decisionCorrelationId: "dcid-1" },
    });
  });
});
```

- [ ] **Step 2: Run red**

Run:

```bash
bun test packages/lib/decision-graph/src/materialize.test.ts
```

Expected: fails because implementation does not exist.

- [ ] **Step 3: Implement `errors.ts`**

Create:

```ts
import type { KoiError } from "@koi/core";

export function validationError(message: string): KoiError {
  return { code: "VALIDATION", message, retryable: false };
}

export function externalError(message: string, cause?: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
  };
}
```

- [ ] **Step 4: Implement fakes**

Create `test-fakes.ts` by adapting `packages/lib/decision-index/src/test-fakes.ts`. Keep the same `makeLedger()` and `makeOutcome()` signatures so graph and index tests share mental shape.

- [ ] **Step 5: Implement materializer**

Create `materialize.ts`:

```ts
import type { DecisionGraphEdge, DecisionGraphNode, DecisionSubgraph, MaterializeLedgerGraphInput } from "./types.js";

function correlationFrom(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = metadata?.decisionCorrelationId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function edge(
  from: string,
  kind: DecisionGraphEdge["kind"],
  to: string,
  metadata: Readonly<Record<string, unknown>> = {},
): DecisionGraphEdge {
  return { id: `edge:${from}:${kind}:${to}`, kind, from, to, metadata };
}

export function materializeLedgerGraph(input: MaterializeLedgerGraphInput): DecisionSubgraph {
  const { ledger } = input;
  const sessionNode: DecisionGraphNode = {
    id: `session:${ledger.sessionId}`,
    kind: "session",
    label: ledger.sessionId,
    sessionId: ledger.sessionId,
    metadata: {
      trajectorySourceState: ledger.sources.trajectory.state,
      auditSourceState: ledger.sources.audit.state,
      reportSourceState: ledger.sources.report.state,
    },
  };

  const stepNodes = ledger.trajectorySteps.map((step): DecisionGraphNode => ({
    id: `session:${ledger.sessionId}:step:${step.stepIndex}`,
    kind: "trajectory-step",
    label: `${step.kind} ${step.identifier}`,
    sessionId: ledger.sessionId,
    timestampMs: step.timestamp,
    metadata: {
      stepIndex: step.stepIndex,
      stepKind: step.kind,
      identifier: step.identifier,
      ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
      ...(correlationFrom(step.metadata) !== undefined
        ? { decisionCorrelationId: correlationFrom(step.metadata) }
        : {}),
    },
  }));

  const auditNodes = ledger.auditEntries.map((entry, index): DecisionGraphNode => ({
    id: `session:${ledger.sessionId}:audit:${index}`,
    kind: "audit-entry",
    label: entry.kind,
    sessionId: ledger.sessionId,
    timestampMs: entry.timestamp,
    metadata: { auditKind: entry.kind, turnIndex: entry.turnIndex },
  }));

  const reportNodes =
    ledger.runReport !== undefined
      ? [
          {
            id: `session:${ledger.sessionId}:report:${ledger.runReport.duration.completedAt}`,
            kind: "run-report" as const,
            label: ledger.runReport.summary,
            sessionId: ledger.sessionId,
            timestampMs: ledger.runReport.duration.completedAt,
            metadata: { runId: ledger.runReport.runId },
          },
        ]
      : [];

  const outcomeNodes = (input.outcomes ?? []).map((outcome): DecisionGraphNode => ({
    id: `outcome:${String(outcome.correlationId)}`,
    kind: "outcome-report",
    label: outcome.description,
    sessionId: ledger.sessionId,
    timestampMs: outcome.timestamp,
    metadata: { outcome: outcome.outcome, decisionCorrelationId: String(outcome.correlationId) },
  }));

  const containsEdges = [...stepNodes, ...auditNodes, ...reportNodes, ...outcomeNodes].map((node) =>
    edge(sessionNode.id, "contains", node.id),
  );

  const outcomeByCorrelation = new Map(
    outcomeNodes.map((node) => [String(node.metadata.decisionCorrelationId), node] as const),
  );
  const correlationEdges = stepNodes.flatMap((node) => {
    const correlationId = node.metadata.decisionCorrelationId;
    if (typeof correlationId !== "string") return [];
    const outcome = outcomeByCorrelation.get(correlationId);
    return outcome !== undefined
      ? [edge(node.id, "correlates-with", outcome.id, { decisionCorrelationId: correlationId })]
      : [];
  });

  return {
    nodes: [sessionNode, ...stepNodes, ...auditNodes, ...reportNodes, ...outcomeNodes],
    edges: [...containsEdges, ...correlationEdges],
  };
}
```

- [ ] **Step 6: Write in-memory traversal tests**

Create `in-memory-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createInMemoryDecisionGraphStore } from "./in-memory-store.js";

describe("createInMemoryDecisionGraphStore", () => {
  test("neighbors respects direction and depth", async () => {
    const store = createInMemoryDecisionGraphStore();
    await store.upsert(
      [
        { id: "a", kind: "session", label: "a", metadata: {} },
        { id: "b", kind: "trajectory-step", label: "b", metadata: {} },
        { id: "c", kind: "outcome-report", label: "c", metadata: {} },
      ],
      [
        { id: "ab", kind: "contains", from: "a", to: "b", metadata: {} },
        { id: "bc", kind: "correlates-with", from: "b", to: "c", metadata: {} },
      ],
    );

    const result = await store.neighbors({ nodeId: "a", direction: "out", depth: 2 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
      expect(result.value.edges.map((e) => e.id).sort()).toEqual(["ab", "bc"]);
    }
  });

  test("path returns shortest path within maxDepth", async () => {
    const store = createInMemoryDecisionGraphStore();
    await store.upsert(
      [
        { id: "a", kind: "session", label: "a", metadata: {} },
        { id: "b", kind: "trajectory-step", label: "b", metadata: {} },
        { id: "c", kind: "outcome-report", label: "c", metadata: {} },
      ],
      [
        { id: "ab", kind: "contains", from: "a", to: "b", metadata: {} },
        { id: "bc", kind: "correlates-with", from: "b", to: "c", metadata: {} },
      ],
    );

    const result = await store.path({ from: "a", to: "c", maxDepth: 2 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.edges.map((e) => e.id)).toEqual(["ab", "bc"]);
    }
  });
});
```

- [ ] **Step 7: Implement in-memory store**

Create `in-memory-store.ts` with immutable updates and BFS traversal. Validate `depth` is `1..3` and `maxDepth` is `1..6`; return `VALIDATION` errors otherwise.

- [ ] **Step 8: Verify**

Run:

```bash
bun test packages/lib/decision-graph/src/materialize.test.ts packages/lib/decision-graph/src/in-memory-store.test.ts
bun run --cwd packages/lib/decision-graph typecheck
```

Expected: pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add packages/lib/decision-graph package.json bun.lock tsconfig.json
git commit -m "feat(decision-graph): materialize decision artifacts"
```

Only stage root files if changed.

## Task 7: Implement Nexus VFS and RecordStore Graph Adapters

**Files:**
- Create: `packages/lib/decision-graph/src/nexus-vfs-store.test.ts`
- Create: `packages/lib/decision-graph/src/nexus-vfs-store.ts`
- Create: `packages/lib/decision-graph/src/nexus-record-store.test.ts`
- Create: `packages/lib/decision-graph/src/nexus-record-store.ts`

- [ ] **Step 1: Write VFS persistence test**

Create `nexus-vfs-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createNexusVfsDecisionGraphStore } from "./nexus-vfs-store.js";
import { createMockTransport } from "./test-transport.js";

describe("createNexusVfsDecisionGraphStore", () => {
  test("persists nodes and edges across fresh store instances", async () => {
    const transport = createMockTransport();
    const first = createNexusVfsDecisionGraphStore({ transport });
    await first.upsert(
      [
        { id: "a", kind: "session", label: "a", metadata: {} },
        { id: "b", kind: "trajectory-step", label: "b", metadata: {} },
      ],
      [{ id: "ab", kind: "contains", from: "a", to: "b", metadata: {} }],
    );

    const second = createNexusVfsDecisionGraphStore({ transport });
    const result = await second.neighbors({ nodeId: "a", direction: "out", depth: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
      expect(result.value.edges.map((e) => e.id)).toEqual(["ab"]);
    }
  });
});
```

- [ ] **Step 2: Implement VFS store**

Use `NexusTransport.call("write" | "read" | "glob")` with paths:

```text
/decision-graph/nodes/{encodedNodeId}.json
/decision-graph/edges/{encodedEdgeId}.json
/decision-graph/index/by-node/{encodedNodeId}.json
```

Implementation may reuse the in-memory traversal by loading the relevant persisted nodes/edges into a temporary in-memory store.

- [ ] **Step 3: Write RecordStore HTTP adapter tests**

Create `nexus-record-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createNexusRecordStoreDecisionGraphStore } from "./nexus-record-store.js";

describe("createNexusRecordStoreDecisionGraphStore", () => {
  test("neighbors calls Nexus graph API with auth header", async () => {
    const calls: readonly { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as { readonly url: string; readonly init: RequestInit | undefined }[]).push({
        url: String(url),
        init,
      });
      return Response.json({ entities: [], relationships: [] });
    };
    const store = createNexusRecordStoreDecisionGraphStore({
      fetch: fetchImpl,
      url: "http://nexus.local",
      apiKey: "secret",
    });

    const result = await store.neighbors({ nodeId: "n1", direction: "both", depth: 2 });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("http://nexus.local/api/v2/graph/entity/n1/neighbors?hops=2&direction=both");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });
});
```

- [ ] **Step 4: Implement RecordStore HTTP adapter**

Implement:

- `upsert()` calls `POST /api/v2/graph/decision-artifacts` with `{ nodes, edges }`. Current Nexus graph deployments may not expose this Koi-specific write route; a 404/405 returns an `EXTERNAL` KoiError with message `Nexus decision graph write endpoint unavailable`.
- `neighbors()` calls `/api/v2/graph/entity/{id}/neighbors?hops={depth}&direction={direction}`.
- `path()` calls `/api/v2/graph/subgraph` with `entity_ids: [from, to]` and returns the subgraph response as a bounded path candidate. If the response has no relationships connecting `from` to `to`, return `{ nodes: [], edges: [] }`.
- Non-2xx responses return `EXTERNAL` KoiError.

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/lib/decision-graph/src/nexus-vfs-store.test.ts packages/lib/decision-graph/src/nexus-record-store.test.ts
bun run --cwd packages/lib/decision-graph build
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/lib/decision-graph
git commit -m "feat(decision-graph): add Nexus graph stores"
```

## Task 8: Wire Decision Graph Into Runtime

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/src/types.ts`
- Modify: `packages/meta/runtime/src/create-runtime.ts`
- Modify: `packages/meta/runtime/src/index.ts`
- Modify: `packages/meta/runtime/src/create-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add:

```ts
test("createDecisionGraph uses injected graph store", () => {
  const runtime = createRuntime({ trajectoryDir: `/tmp/koi-decision-graph-${Date.now()}` });
  const graphStore = {
    upsert: async () => ({ ok: true, value: { nodeCount: 0, edgeCount: 0 } }),
    neighbors: async () => ({ ok: true, value: { nodes: [], edges: [] } }),
    path: async () => ({ ok: true, value: { nodes: [], edges: [] } }),
  } satisfies import("@koi/decision-graph").DecisionGraphStore;

  expect(runtime.createDecisionGraph?.({ graphStore })).toBe(graphStore);
});
```

- [ ] **Step 2: Run red**

Run:

```bash
bun run --cwd packages/lib/decision-graph build
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: fails because runtime does not expose `createDecisionGraph`.

- [ ] **Step 3: Add runtime dependency and types**

Add `@koi/decision-graph` dependency and extend `RuntimeHandle` with:

```ts
readonly createDecisionGraph:
  | ((options:
      | { readonly graphStore: DecisionGraphStore }
      | { readonly nexusGraph: NexusRecordStoreDecisionGraphConfig }
      | { readonly nexusVfs: NexusVfsDecisionGraphConfig }) => DecisionGraphStore)
  | undefined;
```

- [ ] **Step 4: Implement factory**

In `create-runtime.ts`, return injected graph store directly, create HTTP adapter for `nexusGraph`, and create VFS adapter for `nexusVfs`.

- [ ] **Step 5: Verify**

Run:

```bash
bun run --cwd packages/meta/runtime typecheck
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/meta/runtime package.json bun.lock
git commit -m "feat(runtime): expose decision graph factory"
```

## Task 9: Golden Tests and Docs

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`
- Add: `docs/L2/decision-index.md`
- Add: `docs/L2/decision-graph.md`
- Modify: `docs/L2/decision-ledger.md`
- Modify: `docs/L3/runtime.md`
- Modify: `docs/package-coverage-map.md` if package list is maintained there

- [ ] **Step 1: Add standalone decision-index golden**

Add a `describe("Golden: @koi/decision-index", ...)` block that imports `@koi/decision-index`, uses a fake `SearchBackend`, indexes a fake ledger, and asserts searching by `decisionCorrelationId` forwards the structured filter.

- [ ] **Step 2: Add standalone decision-graph golden**

Add a `describe("Golden: @koi/decision-graph", ...)` block that materializes a fake ledger with an outcome and asserts a path from session node to outcome node.

- [ ] **Step 3: Write docs**

`docs/L2/decision-index.md` must include:

- purpose
- package boundary
- input/output types
- privacy/bounded metadata note
- usage with `@koi/search-nexus`
- tests

`docs/L2/decision-graph.md` must include:

- graph model
- materializer rules
- in-memory, Nexus VFS, Nexus RecordStore HTTP adapters
- traversal bounds
- no timestamp-only causality rule

- [ ] **Step 4: Update existing docs**

Update `docs/L2/decision-ledger.md` follow-up list so Phase 2(b) is no longer described as blocked on `@koi/search-nexus`.

Update `docs/L3/runtime.md` with the optional runtime factories.

- [ ] **Step 5: Verify docs and goldens**

Run:

```bash
bun test packages/meta/runtime/src/__tests__/golden-replay.test.ts --test-name-pattern "decision-index|decision-graph|search-nexus"
git diff --check
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts docs/L2/decision-index.md docs/L2/decision-graph.md docs/L2/decision-ledger.md docs/L3/runtime.md docs/package-coverage-map.md
git commit -m "docs: document decision index and graph"
```

Only stage `docs/package-coverage-map.md` if changed.

## Task 10: Full Verification

**Files:** all changed files.

- [ ] **Step 1: Build changed packages**

Run:

```bash
bun run --cwd packages/kernel/core build
bun run --cwd packages/lib/decision-ledger build
bun run --cwd packages/lib/decision-index build
bun run --cwd packages/lib/decision-graph build
bun run --cwd packages/meta/runtime build
```

Expected: all builds pass.

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test packages/meta/runtime/src/trajectory/nexus-delegate.test.ts
bun test packages/lib/decision-index
bun test packages/lib/decision-graph
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run --cwd packages/lib/decision-index typecheck
bun run --cwd packages/lib/decision-graph typecheck
bun run --cwd packages/meta/runtime typecheck
```

Expected: all pass.

- [ ] **Step 4: Run golden query repo check**

Run:

```bash
bun run check:golden-queries
```

Expected: pass. If runtime golden scope is too slow or unrelated failures appear, capture exact failing tests and diagnose before claiming completion.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: clean worktree and phase commits present.
