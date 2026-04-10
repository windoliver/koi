# @koi/decision-ledger

> Read-only per-session projection that joins trajectory steps and audit entries into a single time-ordered timeline, with the run report attached as a sidecar summary.

## Why it exists

Decision-relevant data in Koi lives in three independent sinks:

- **Trajectory** (`TrajectoryDocumentStore`) — every model call and tool call, with full request/response content. Persisted via `@koi/event-trace` and the Nexus-backed delegate from #1592.
- **Audit** (`AuditSink`) — every permission decision emitted by `@koi/middleware-permissions`: tool call approvals, denials, filter decisions.
- **Run report** (`ReportStore`) — the structured summary produced by `@koi/middleware-report` at session end.

Operators investigating "what actually happened on this session?" currently have to query all three by hand and stitch them together. This package is that stitching, done once, as a diagnostic read API.

It is Phase 2 part (a) of issue [#1469](https://github.com/windoliver/koi/issues/1469). Phase 1 shipped Nexus-backed trajectory persistence in PR #1592; Phase 2(b) (cross-session index) is blocked on porting `@koi/search-nexus`; Phase 3 (graph) is future work.

## What it is NOT

- ❌ **Not a new storage layer.** Reads existing sinks, writes nothing.
- ❌ **Not a mutation API.** No "mark resolved", no "annotate decision".
- ❌ **Not a cross-session index.** Strictly one session in, one timeline out.
- ❌ **Not a streaming surface.** Single-shot query returning the full timeline.
- ❌ **Not an extension point.** This is a diagnostic projection, not one of Koi's 10 core vocabulary concepts.
- ❌ **Not a denial bridge.** Permissions middleware already audits every decision. This package reads audit; it does not duplicate-log.

## Layer position

```
L0  @koi/core
    ├── RichTrajectoryStep, TrajectoryDocumentStore   (rich-trajectory.ts)
    ├── AuditEntry, AuditSink                         (audit-backend.ts)
    ├── RunReport, ReportStore, ActionEntry           (run-report.ts)
    └── Result, KoiError, RETRYABLE_DEFAULTS          (errors.ts)

L2  @koi/decision-ledger ◄── THIS PACKAGE
    ├── DecisionLedgerEntry (discriminated union)
    ├── DecisionLedger, DecisionLedgerReader
    └── createDecisionLedger(config)
```

**Dependencies:** `@koi/core` only. No L2 peers. No external packages.

## Types

```typescript
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AuditEntry, AuditSink, KoiError, Result } from "@koi/core";
import type { ReportStore, RunReport } from "@koi/core/run-report";

export type DecisionLedgerEntry =
  | {
      readonly kind: "trajectory-step";
      readonly timestamp: number;  // ms since epoch, hoisted from RichTrajectoryStep
      readonly stepIndex: number;  // secondary sort tiebreaker
      readonly source: RichTrajectoryStep;
    }
  | {
      readonly kind: "audit";
      readonly timestamp: number;  // ms since epoch, hoisted from AuditEntry
      readonly turnIndex: number;
      readonly source: AuditEntry;
    };

export type SourceStatus =
  | { readonly state: "present" }
  | { readonly state: "missing" }                        // sink returned empty/undefined
  | { readonly state: "unqueryable" }                    // sink absent or lacks .query
  | { readonly state: "error"; readonly error: KoiError };

export interface DecisionLedger {
  readonly sessionId: string;
  readonly entries: readonly DecisionLedgerEntry[];      // sorted by timestamp ascending, stable within source
  readonly runReport?: RunReport | undefined;            // latest RunReport for the session, if any
  readonly sources: {
    readonly trajectory: SourceStatus;
    readonly audit: SourceStatus;
    readonly report: SourceStatus;
  };
}

export interface DecisionLedgerReader {
  readonly getLedger: (sessionId: string) => Promise<Result<DecisionLedger, KoiError>>;
}

export interface DecisionLedgerConfig {
  readonly trajectoryStore: Pick<TrajectoryDocumentStore, "getDocument">;
  readonly auditSink?: AuditSink | undefined;
  readonly reportStore?: ReportStore | undefined;
}

export function createDecisionLedger(config: DecisionLedgerConfig): DecisionLedgerReader;
```

## Usage

```typescript
import { createDecisionLedger } from "@koi/decision-ledger";

const ledger = createDecisionLedger({
  trajectoryStore: runtime.trajectoryStore,
  auditSink: runtime.auditSink,           // optional
  reportStore: runtime.reportStore,       // optional
});

const result = await ledger.getLedger("session-abc-123");
if (!result.ok) {
  console.error("catastrophic failure:", result.error.message);
  return;
}

const { entries, runReport, sources } = result.value;
console.log(`${entries.length} events, trajectory ${sources.trajectory.state}, audit ${sources.audit.state}`);

for (const entry of entries) {
  if (entry.kind === "trajectory-step") {
    console.log(`[${entry.timestamp}] trajectory ${entry.source.kind}: ${entry.source.identifier}`);
  } else {
    console.log(`[${entry.timestamp}] audit ${entry.source.kind} turn=${entry.turnIndex}`);
  }
}
```

## Ordering guarantees

Entries are sorted by wall-clock `timestamp` (ms since epoch) **ascending**. Within a single source, records retain their input order (the sort is stable — ES2019 guarantees this for `Array.prototype.sort`). Ties across sources place trajectory entries before audit entries.

### Wall-clock caveat (important)

The ledger orders by wall-clock only, **not causal ordering**. When trajectory and audit record the same logical event (e.g., a tool call), they emit at slightly different clocks — the two entries may appear in either order depending on which sink's `timestamp` was taken first. If you need causal ordering, look at `decisionCorrelationId` in `RichTrajectoryStep.metadata` when populated by the event-trace adapter.

Stated plainly: this ledger is for "show me everything that happened on this session in roughly the right order," not "prove the causal graph of these events."

## Sink status model

Each of the three sinks reports its fetch outcome independently:

| State | Meaning |
|-------|---------|
| `present` | Sink returned at least one record (or, for report, at least one `RunReport`). |
| `missing` | Sink was queryable and returned zero records — session never recorded. |
| `unqueryable` | Sink was not configured, or (for audit) the configured sink has no `.query()` method. |
| `error` | Sink threw during the fetch. `error` field carries the normalized `KoiError`. **Other sinks' results are preserved.** |

A per-sink failure never fails the whole call. The ledger reports `{ok: true}` with `sources.<sink>.state === "error"`; catastrophic failure (invalid input, internal bug) returns `{ok: false}`.

## Edge cases

- **Empty session** (trajectory returned empty) → `entries: []`, `sources.trajectory.state === "missing"`. Not an error.
- **Audit sink present, no `.query`** → `sources.audit.state === "unqueryable"`. Ledger surfaces trajectory only.
- **Audit sink throws** → `sources.audit.state === "error"`, trajectory still present.
- **Multiple run reports for same session** → the one with the largest `duration.completedAt` wins.
- **50k+ combined entries** → logged warning; no pagination. File a follow-up if this becomes common.
- **Empty `sessionId`** → `{ok: false, error: { code: "VALIDATION", ... }}`.

## Configuration requirements

To get useful output you need at minimum a `trajectoryStore` (always present in any runtime post-#1592). Audit surfacing additionally requires:

1. A concrete `AuditSink` implementation configured on the runtime.
2. That sink must implement the optional `query(sessionId)` method.

Run report surfacing requires a concrete `ReportStore`. Neither audit nor report has a default v2 implementation at the time of writing — both are tracked as follow-up issues. The ledger ships with `sources.audit.state === "unqueryable"` and `sources.report.state === "unqueryable"` as the expected near-term production shape.

## Testing

Unit tests live alongside source files (`*.test.ts`) and cover:

- Happy-path join (trajectory + audit interleaved, stable sort)
- Sink status matrix (present × missing × unqueryable × error for every sink)
- Sidecar report resolution (none / single / multiple → latest wins)
- Catastrophic failure (empty sessionId)
- Large session (10k trajectory + 10k audit, soft ceiling warning)

Standalone golden queries in `@koi/runtime` feed fake sink data and assert the join shape — no LLM needed (see `packages/meta/runtime/src/__tests__/golden-replay.test.ts`, `describe("Golden: @koi/decision-ledger", ...)`).

A replay-driven golden query would require extending the recorder to wire an `AuditSink` + `ReportStore` and exposing a post-session inspection hook. That is out of scope for Phase 2(a) and tracked as a follow-up.

## Follow-ups tracked

1. Default v2 `AuditSink` implementation (Nexus-backed, queryable).
2. Default v2 `ReportStore` implementation.
3. Replay lifecycle hooks so the ledger can graduate to a replay-driven golden query.
4. Phase 2 part (b) — cross-session decision index (blocked on `@koi/search-nexus` port).
5. Phase 3 — graph capability (Nexus RecordStore adapter + context graph materialization).
