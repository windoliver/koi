# @koi/decision-ledger

> Read-only per-session projection that exposes trajectory steps and audit entries as separate ordered lanes, with the run report attached as a sidecar summary. Deliberately does NOT merge the lanes into a single timeline — see the ordering discussion below.

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
- ❌ **Not a merged causal timeline.** Without a shared causal key across trajectory and audit, any wall-clock merge would be misleading — an approval audit entry could render on the wrong side of the step it governed. The lanes stay separate by design.

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

export type SourceStatus =
  | { readonly state: "present" }  // clean — no leakage
  | {
      /**
       * Lane has usable data AND the sink returned records for other
       * sessions. Forces explicit handling via dedicated discriminant
       * — a naive `state === "present"` switch will NOT match.
       */
      readonly state: "present-with-leakage";
      readonly integrityFilteredCount: number;
    }
  | { readonly state: "missing" }  // sink legitimately returned zero records
  | {
      /**
       * Dedicated state: the sink returned records but every one belonged
       * to a different session. Do NOT alias to `missing`.
       */
      readonly state: "integrity-violation";
      readonly integrityFilteredCount: number;
    }
  | { readonly state: "unqueryable" }                    // sink absent or lacks .query
  | { readonly state: "error"; readonly error: KoiError };

export interface IntegrityLeakCounts {
  /** Records the audit sink returned for other sessions (dropped on partial-leak fetches). */
  readonly audit: number;
  /** Records the report store returned for other sessions (dropped on partial-leak fetches). */
  readonly report: number;
  // Trajectory is deliberately absent — see TrajectoryTrustModel below.
}

/**
 * Trajectory lane trust is store-authoritative, NOT field-verified.
 * RichTrajectoryStep has no sessionId field so the ledger cannot
 * re-validate trajectory records against the requested session.
 */
export type TrajectoryTrustModel = "store-authoritative";

export interface DecisionLedger {
  readonly sessionId: string;
  /** Trajectory steps in `stepIndex` order (ledger re-sorts if the store returns shuffled records). */
  readonly trajectorySteps: readonly RichTrajectoryStep[];
  /** Audit entries for this session, sorted ascending by timestamp. */
  readonly auditEntries: readonly AuditEntry[];
  /** Latest run report for this session, when a ReportStore is configured. */
  readonly runReport?: RunReport | undefined;
  readonly sources: {
    readonly trajectory: SourceStatus;
    readonly audit: SourceStatus;
    readonly report: SourceStatus;
  };
  /**
   * Top-level integrity discriminator for sinks the ledger CAN re-validate.
   * Non-zero on any sink → trust-boundary failure. Must be checked
   * independently of `sources.*.state`.
   */
  readonly integrityLeakCounts: IntegrityLeakCounts;
  /** Always `"store-authoritative"` — see caveat below. */
  readonly trajectoryTrustModel: TrajectoryTrustModel;
  /**
   * Literal-`false` flat signal. A caller writing
   * `if (ledger.allLanesFieldVerified) trust()` always takes the else
   * branch, because trajectory cannot be field-verified. Exists so
   * flat shortcut checks on `integrityLeakCounts === {0,0}` cannot be
   * mistaken for "ledger is fully trustworthy."
   */
  readonly allLanesFieldVerified: false;
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

### From a `RuntimeHandle` (recommended)

`@koi/runtime` exposes a `createDecisionLedger` factory on the handle when the runtime has a `trajectoryStore`. This is the easy path — the runtime wires its own `trajectoryStore` and `reportStore` (if configured), and callers can optionally inject an ad-hoc `auditSink` via the override.

```typescript
import { createRuntime } from "@koi/runtime";

const runtime = createRuntime({ adapter, channel, trajectoryDir: "./traj" });
if (runtime.createDecisionLedger) {
  const ledger = runtime.createDecisionLedger({
    // optional override — inject an ad-hoc audit sink for incident tooling
    auditSink: myAuditSink,
  });
  const result = await ledger.getLedger("session-abc-123");
}
```

The handle field is `undefined` when the runtime has no `trajectoryStore` (i.e., no `trajectoryDir` / `trajectoryNexus` configured), since trajectory is the required input for the ledger.

### Direct construction (for tests or custom assemblies)

```typescript
import { createDecisionLedger } from "@koi/decision-ledger";

const ledger = createDecisionLedger({
  trajectoryStore,                        // required
  auditSink,                              // optional
  reportStore,                            // optional
});

const result = await ledger.getLedger("session-abc-123");
if (!result.ok) {
  console.error("catastrophic failure:", result.error.message);
  return;
}

const { trajectorySteps, auditEntries, runReport, sources } = result.value;
console.log(
  `trajectory:${sources.trajectory.state} audit:${sources.audit.state} report:${sources.report.state}`,
);

for (const step of trajectorySteps) {
  console.log(`[traj ${step.stepIndex}] ${step.kind} ${step.identifier}`);
}
for (const entry of auditEntries) {
  console.log(`[audit ${entry.timestamp}] ${entry.kind} turn=${entry.turnIndex}`);
}
```

## Ordering guarantees

Each lane is ordered in its own source-native way:

- `trajectorySteps`: sorted ascending by `stepIndex`. `TrajectoryDocumentStore.getDocument()` does not guarantee sorted output (compaction, replay, or backend-specific enumeration can shuffle records), so the ledger re-sorts before exposing the lane.
- `auditEntries`: sorted by `timestamp` ascending after session-integrity filtering. Stable ES2019 sort — ties preserve input order.

### Why no merged timeline

Without a shared causal key across trajectory and audit (such as a correlation id present on both), a wall-clock merge would be misleading: an approval audit entry recorded a few milliseconds before the tool step that it governed (or a few milliseconds after) would render on the wrong side of the decision. For a diagnostic surface used in incident review and permission debugging, that is a material correctness problem on exactly the edge cases the ledger is meant to explain.

The lanes stay separate. If a caller needs a combined display, they merge explicitly with full awareness of the caveat — and if the event-trace adapter populates `decisionCorrelationId` on the trajectory step metadata, that is the right key to join on, not wall-clock.

## Sink status model

Each of the three sinks reports its fetch outcome independently:

| State | Meaning |
|-------|---------|
| `present` | Clean fetch — lane has usable data, no leakage. Only emitted for audit and report lanes. |
| `present-with-leakage` | Lane has usable data AND the sink returned records for other sessions (dropped by the integrity filter). **Distinct state** so a naive `state === "present"` switch drops records instead of rendering leaky data. Carries `integrityFilteredCount` and the top-level `integrityLeakCounts.<sink>` is non-zero. |
| `present-unverified` | **Trajectory lane only.** Lane has records but the ledger cannot field-verify them against the requested session. Distinct from `present` so callers cannot mistake store-authoritative output for verified data. See the Trajectory trust model section below. |
| `missing` | Sink was queryable and returned zero records — the session was never recorded. |
| `integrity-violation` | Sink returned records but every one belonged to a different session. Lane has no usable data. Carries `integrityFilteredCount`. |
| `unqueryable` | Sink was not configured, or (for audit) the configured sink has no `.query()` method. |
| `error` | Sink threw during the fetch. `error` field carries the normalized `KoiError`. **Other sinks' results are preserved.** |

A per-sink failure never fails the whole call. The ledger reports `{ok: true}` with `sources.<sink>.state === "error"`; catastrophic failure (invalid input, internal bug) returns `{ok: false}`.

### Session-integrity filtering

For audit and run-report sinks, the ledger re-validates that every returned record's own `sessionId` matches the requested session. Any mismatched records are dropped before the lane is exposed, a warning is logged, and the count is surfaced structurally. There are two distinct states depending on whether anything matched:

- **Partial leak** (mix of correct and wrong-session records): `sources.<sink>.state === "present-with-leakage"` with `integrityFilteredCount` on the status. Lane is usable but a naive `state === "present"` switch will miss it — forcing explicit handling. The same count is mirrored on `DecisionLedger.integrityLeakCounts.<sink>` for callers that prefer a top-level discriminator.
- **All records dropped** (sink returned only other-session data): `sources.<sink>.state === "integrity-violation"` with `integrityFilteredCount`. Lane has no usable data.

This protects against buggy sink implementations, stale secondary indices, and over-broad backend reads leaking another session's decision data through the diagnostic surface — for audit and report.

### Trajectory trust model caveat (important)

**Trajectory is NOT included in `integrityLeakCounts`.** `RichTrajectoryStep` has no `sessionId` field, so the ledger cannot structurally re-validate trajectory records against the requested session. The `TrajectoryDocumentStore`'s keying by `docId` IS the session identity — trust is store-authoritative.

A buggy, stale, or over-broad `TrajectoryDocumentStore` implementation that returns records for the wrong `docId` **would be an undetected cross-session leak on the trajectory lane**. There is no field-level signal the ledger can raise. The `DecisionLedger.trajectoryTrustModel` field (always `"store-authoritative"`) is present specifically so callers cannot mistake the absence of trajectory from `integrityLeakCounts` for a "verified clean" result.

Callers who need stronger trajectory-lane guarantees must use a `TrajectoryDocumentStore` implementation whose keying is cryptographically scoped to the caller's session identity, or add their own out-of-band reconciliation. This is a schema limitation, not a ledger bug — it is called out explicitly in the type surface and docs so incident tooling can decide whether the store in use is trustworthy.

Callers should detect integrity violations programmatically — `console.warn` alone is not a reliable signal for incident tooling. Three distinct cases to watch for:

- **`state === "integrity-violation"`** — strictly worse than `missing`: the sink returned data, all of it for the wrong session. Backend trust-boundary failure. Alert immediately.
- **`state === "present-with-leakage"`** — partial leak: the sink returned a mix of correct and wrong-session records. Lane is usable but the sink is misbehaving. Forces explicit caller handling via the dedicated discriminant.
- **`integrityLeakCounts.audit > 0` or `integrityLeakCounts.report > 0`** — redundant top-level signal for callers that prefer a flat discriminator over an exhaustive state switch.

### Which states carry usable records?

Different lanes use different subsets of `SourceStatus`. Callers writing generic "has data" checks must cover **all** usable-data states for the lane(s) they consume:

| Lane | States that carry usable records |
|------|----------------------------------|
| `auditEntries` | `present`, `present-with-leakage` |
| `runReport` | `present`, `present-with-leakage` |
| `trajectorySteps` | `present-unverified` *(only state that carries trajectory data — trajectory is never `present`)* |

A naive `state === "present"` check will **intentionally** not match `present-with-leakage` (fail-safe on leaky sinks) or `present-unverified` (fail-safe on unverifiable lanes). If you want to render all usable data regardless of integrity caveats, use an exhaustive switch (see example below) and alert on the non-clean branches.

Example (exhaustive switches per lane):

```typescript
const { sources, integrityLeakCounts } = result.value;

// Audit / report lanes share the same usable-data subset.
switch (sources.audit.state) {
  case "present":
    render(result.value.auditEntries);
    break;
  case "present-with-leakage":
    render(result.value.auditEntries);
    alert.partialIntegrityLeak({ sink: "audit", dropped: sources.audit.integrityFilteredCount });
    break;
  case "integrity-violation":
    alert.integrityViolation({ sink: "audit", dropped: sources.audit.integrityFilteredCount });
    break;
  case "missing":
  case "unqueryable":
  case "error":
    // explicit handling — see sources.audit.error on the error branch
    break;
}

// Trajectory has its own usable-data state: never `present`, always
// `present-unverified` when records exist.
switch (sources.trajectory.state) {
  case "present-unverified":
    render(result.value.trajectorySteps);
    // Trust is store-authoritative — document or alert per your threat model.
    break;
  case "missing":
  case "error":
    break;
  // `present`, `present-with-leakage`, `integrity-violation`, `unqueryable`
  // are unreachable for trajectory by construction.
  default:
    break;
}
```

## Edge cases

- **Empty session** (trajectory returned empty) → `trajectorySteps: []`, `sources.trajectory.state === "missing"`. Not an error.
- **Audit sink present, no `.query`** → `sources.audit.state === "unqueryable"`. Ledger surfaces trajectory only.
- **Audit sink throws** → `sources.audit.state === "error"`, trajectory lane still present.
- **Audit sink returns a mix of correct and wrong-session records** → wrong ones dropped with a warning; lane exposes only matching records; `sources.audit.state === "present-with-leakage"`; `integrityLeakCounts.audit` mirrors the dropped count. A naive `state === "present"` switch drops the records (fail-safe).
- **Audit sink returns only other-session records** → `sources.audit.state === "integrity-violation"` with `integrityFilteredCount`. Do NOT alias to `missing`.
- **Multiple run reports for same session** → among the records whose `sessionId` matches, the one with the largest `duration.completedAt` wins.
- **Run report with mismatched sessionId (partial)** → dropped; counted in `integrityLeakCounts.report`.
- **Run report with only mismatched sessionIds** → `sources.report.state === "integrity-violation"`.
- **Oversized raw response** → combined raw sink response sizes above 50k trigger a soft-ceiling warning even if the filtered lanes are small (catches pathological partial-leak payloads).
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

## `AuditEntry.schema_version` (compatibility note, #1627)

`@koi/core`'s `AuditEntry` interface gained a required `schema_version: number` field in #1627. The `makeAuditEntry()` test fake in `src/test-fakes.ts` was updated to include `schema_version: 1` in its default shape so all downstream tests remain type-correct under `exactOptionalPropertyTypes`.
