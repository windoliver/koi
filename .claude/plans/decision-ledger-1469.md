# Decision Ledger — Issue #1469 Phase 2 (part a)

**Branch:** `feat/decision-ledger-1469`
**Worktree:** `/Users/sophiawj/private/koi-wt-decision-ledger-1469`
**Scope:** Per-session decision ledger projection — read-only join over trajectory + audit, with run report as a sidecar summary.
**Revision:** 2 (post-Codex adversarial review, 2026-04-09)

## What changed vs revision 1

Codex review surfaced four blockers and six majors against the first draft. Revision 2 honestly scopes around the schemas that actually exist today:

- **Ordering key is `timestamp` only.** `RichTrajectoryStep` has `stepIndex + timestamp` but no `turnIndex`. `AuditEntry` has `timestamp + turnIndex`. `ActionEntry` has `turnIndex` but **no per-action timestamp**. There is no `(turnIndex, timestamp)` primitive shared across all sinks.
- **Interleaved join is trajectory + audit only.** Both have ms-epoch `timestamp`. Report is attached as a top-level `runReport?` sidecar field on the ledger, not spliced inline.
- **No denial sourcing, no denial→audit bridge.** Permissions middleware already emits audit entries at every decision point (`auditFilterDecision`, `auditDecision`, `auditApprovalOutcome`). Audit IS the single source of decision data; adding a second bridge would double-log. `DenialTracker` is a live-session escalation primitive (and includes `"approval"` sources), not a history store — leave it alone.
- **Use the existing `TrajectoryDocumentStore` seam in L0.** Do not invent a `TrajectoryReader`. Narrow the ledger's dep with `Pick<TrajectoryDocumentStore, "getDocument">`.
- **No new `AuditEntry.kind`.** The L0 union is fixed at `"model_call" | "tool_call" | "session_start" | "session_end" | "secret_access"`. Denials already fit under `tool_call` with metadata carrying the decision — do not propose expanding the union.
- **Golden query is standalone-only.** Current replay recorder does not wire an `auditSink` or `ReportStore`, denial tracker is cleared on `onSessionEnd`, report is only finalized on `onSessionEnd`. A full four-sink replay assertion is not achievable with today's harness and is out of scope.
- **Single PR, not three.** No denial bridge PR, no prerequisite sink-impl PR. Audit sink and report store default implementations are called out as follow-up issues.
- **Surface is `getLedger(sessionId)` only.** No `since/until/kinds` filters until a real caller needs them.
- **Source status models errors explicitly:** `{state: "present" | "missing" | "unqueryable" | "error"; error?: KoiError}`.

## Goal

Given a `sessionId`, return a single time-ordered timeline that interleaves:

1. Trajectory steps (model calls, tool calls) from `TrajectoryDocumentStore.getDocument(sessionId)`
2. Audit entries (approvals, denials, tool/model calls) from `AuditSink.query(sessionId)` when available

Plus, as a sidecar summary (not interleaved):

3. `runReport?: RunReport | undefined` from `ReportStore.getBySession(sessionId)` (latest report) when available

Read-only. Diagnostic surface. Never writes, never mutates upstream state.

## Non-goals (explicit)

- ❌ No new storage.
- ❌ No cross-session index (Phase 2 part b, blocked on `@koi/search-nexus` port).
- ❌ No graph / typed edges (Phase 3).
- ❌ No streaming API.
- ❌ No write/annotate API.
- ❌ No denial→audit bridge — audit already has the data.
- ❌ No new `DecisionLedgerEntry` kind for denials — they appear as audit `tool_call` entries.
- ❌ No `since/until/kinds` query filters.
- ❌ No runtime-replay golden-query assertion — today's harness cannot support it.
- ❌ No default `AuditSink` or `ReportStore` impl. Ledger ships consumer-ready with fake-driven tests; prod wiring follows when sinks exist.
- ❌ No OCC writer mutex (we do not write).

## Current state (verified 2026-04-09 in branch `feat/decision-ledger-1469`)

### RichTrajectoryStep (`packages/kernel/core/src/rich-trajectory.ts:70-95`)
```ts
interface RichTrajectoryStep {
  readonly stepIndex: number;
  readonly timestamp: number;            // ms since epoch
  readonly source: "agent" | "tool" | "user" | "system";
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;
  // request/response/error/reasoningContent/metrics/metadata/bulletIds
}
```
No `turnIndex`. `stepIndex` orders within a single document.

### TrajectoryDocumentStore (`packages/kernel/core/src/rich-trajectory.ts:119-134`)
```ts
interface TrajectoryDocumentStore {
  readonly getDocument: (docId: string) => Promise<readonly RichTrajectoryStep[]>;
  // append/getStepRange/getSize/prune
}
```
Already L0. Already the right seam. Already implemented by `createNexusAtifDelegate` via `@koi/event-trace` (#1592) and by the in-memory/fs delegates.

### AuditEntry (`packages/kernel/core/src/audit-backend.ts:10-28`)
```ts
interface AuditEntry {
  readonly timestamp: number;            // ms since epoch
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly kind: "model_call" | "tool_call" | "session_start" | "session_end" | "secret_access";
  readonly request?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly durationMs: number;
  readonly metadata?: JsonObject;
}

interface AuditSink {
  readonly log: (entry: AuditEntry) => Promise<void>;
  readonly flush?: () => Promise<void>;
  readonly query?: (sessionId: string) => Promise<readonly AuditEntry[]>;
}
```
`query` is optional. No default impl in v2 tree. Permissions middleware calls `sink.log()` at every decision point. **Denial semantics already ride on `kind: "tool_call"` with metadata.** No kind expansion required.

### RunReport / ReportStore (`packages/kernel/core/src/run-report.ts:13-86`)
```ts
interface ActionEntry {
  readonly kind: "model_call" | "tool_call";
  readonly name: string;
  readonly turnIndex: number;
  readonly durationMs: number;
  readonly success: boolean;
  // no timestamp
  // tokenUsage/errorMessage/costUsd
}

interface RunReport {
  readonly sessionId: SessionId;
  readonly duration: { readonly startedAt: number; readonly completedAt: number; ... };
  readonly actions: readonly ActionEntry[];
  // summary/issues/cost/artifacts/recommendations/metadata
}

interface ReportStore {
  readonly getBySession: (id: SessionId) => readonly RunReport[] | Promise<readonly RunReport[]>;
}
```
`ActionEntry` has no per-action timestamp → cannot be interleaved by timestamp with trajectory/audit. We surface the whole `RunReport` as a sidecar summary on the ledger response, not inline.

### DenialTracker (`packages/security/middleware-permissions/src/denial-tracker.ts`)
In-memory per-session ring buffer. `DenialSource` includes `"approval"` — it records approval grants too, so it is NOT a denial-only log. Ledger does not read it. Permissions middleware already audits every decision via the audit sink.

## Package layout

**New L2 package:** `@koi/lib/decision-ledger` at `packages/lib/decision-ledger/`.

Rationale:
- One-sentence description: "Joins a session's trajectory and audit records into a time-ordered decision timeline." ✓ KISS.
- Imports from `@koi/core` only. Does not depend on `@koi/event-trace` (interface dep on `TrajectoryDocumentStore` via L0), `@koi/security/*` (interface dep on `AuditSink` via L0), or `@koi/lib/middleware-report` (interface dep on `ReportStore` via L0). **Layer-clean: L2 → L0 only.**
- Concrete sink instances are injected at assembly time. Ledger never imports any L2 peer.

### Vocabulary note

The Koi vocab caps at ~10 core concepts (Agent, Channel, Tool, Skill, Middleware, Manifest, Engine, Resolver, Gateway, Node). "DecisionLedger" is **not** a new core concept — it's a diagnostic read projection over existing sinks. Frame it as a tool for operators, not an extension point. If reviewers push back on the name, `SessionTimeline` or `createSessionProjection` are acceptable fallbacks — but "decision ledger" is the issue's own language, so keep it unless review objects.

## Types

All in `@koi/lib/decision-ledger/src/types.ts`. Readonly throughout. L0 imports only.

```ts
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AuditEntry, AuditSink } from "@koi/core/audit-backend";
import type { ReportStore, RunReport } from "@koi/core/run-report";
import type { KoiError, Result } from "@koi/core";

export type DecisionLedgerEntry =
  | {
      readonly kind: "trajectory-step";
      readonly timestamp: number;     // ms epoch, hoisted from RichTrajectoryStep.timestamp
      readonly stepIndex: number;      // secondary sort tiebreaker within trajectory
      readonly source: RichTrajectoryStep;
    }
  | {
      readonly kind: "audit";
      readonly timestamp: number;     // ms epoch, hoisted from AuditEntry.timestamp
      readonly turnIndex: number;
      readonly source: AuditEntry;
    };

export type SourceStatus =
  | { readonly state: "present" }
  | { readonly state: "missing" }              // sink returned empty/undefined
  | { readonly state: "unqueryable" }          // sink lacks .query() or is undefined
  | { readonly state: "error"; readonly error: KoiError };

export interface DecisionLedger {
  readonly sessionId: string;
  readonly entries: readonly DecisionLedgerEntry[];  // sorted by (timestamp asc, tiebreaker by insertion order within source)
  readonly runReport?: RunReport | undefined;        // sidecar; latest report for the session if any
  readonly sources: {
    readonly trajectory: SourceStatus;
    readonly audit: SourceStatus;
    readonly report: SourceStatus;
  };
}

export interface DecisionLedgerReader {
  readonly getLedger: (sessionId: string) => Promise<Result<DecisionLedger, KoiError>>;
}
```

Notes:
- `DecisionLedgerEntry` has only two variants (`trajectory-step`, `audit`). Report does not produce entries.
- Timestamp is hoisted to the entry top level so the sort operates without reaching into `source`.
- `Result<DecisionLedger, KoiError>` wrapper lets callers distinguish catastrophic failure (e.g., required `sessionId` invalid) from per-sink degraded state (reflected via `sources`). Per-sink failures are NOT catastrophic — the ledger returns `{ok: true}` with degraded `sources`.

## Factory

```ts
export interface DecisionLedgerConfig {
  readonly trajectoryStore: Pick<TrajectoryDocumentStore, "getDocument">;   // required
  readonly auditSink?: AuditSink | undefined;                               // optional; "unqueryable" if absent or no .query
  readonly reportStore?: ReportStore | undefined;                           // optional; "missing" if absent
}

export function createDecisionLedger(config: DecisionLedgerConfig): DecisionLedgerReader;
```

- Trajectory is required because it is the only sink universally available after Phase 1 (every runtime configures a `TrajectoryDocumentStore`).
- `auditSink` and `reportStore` are both optional. Absent/unqueryable is the common case today.
- `Pick<TrajectoryDocumentStore, "getDocument">` is the narrowest L0 seam — no new interface needed.

## Join algorithm

1. **Parallel fetch** via `Promise.allSettled` over three tasks:
   - Trajectory: `trajectoryStore.getDocument(sessionId)` → `readonly RichTrajectoryStep[]`
   - Audit: `auditSink?.query?.(sessionId)` → `readonly AuditEntry[]` (undefined if sink absent, undefined if `.query` missing)
   - Report: `reportStore?.getBySession(sessionId)` → `readonly RunReport[]` (pick latest by `duration.completedAt` if multiple)
2. **Classify per-sink results:**
   - Fulfilled with data: `{state: "present"}`.
   - Fulfilled with empty array: `{state: "missing"}`.
   - Rejected (threw): `{state: "error", error: normalizeError(reason)}`. Preserve degraded results from other sinks.
   - Sink/method undefined: `{state: "unqueryable"}`.
3. **Normalize.** Wrap each record into its `DecisionLedgerEntry` variant. Hoist `timestamp` to top level. Preserve `stepIndex` for trajectory, `turnIndex` for audit.
4. **Merge + sort.** Stable sort by `timestamp` (ES2019 guarantees `Array.prototype.sort` stability). Ties within the same source preserve input order by virtue of stable sort; ties across sources preserve the concatenation order (trajectory first, then audit).
5. **Attach sidecar.** If report fetch returned a list, pick the most recent `RunReport` by `duration.completedAt`. Set `runReport` on the ledger. If none, leave `undefined`.
6. **Return** `{ok: true, value: DecisionLedger}`.

### Catastrophic failure cases

- `sessionId` empty string → `{ok: false, error: {code: "VALIDATION", ...}}`.
- Internal logic bug (shouldn't happen) → caught at the factory boundary, returned as `{ok: false, error: {code: "INTERNAL", cause}}`.

### Edge cases covered in tests

- Trajectory present, audit unqueryable, report missing → entries are trajectory-only, `sources.audit.state === "unqueryable"`, sidecar absent.
- Trajectory empty (session never recorded) → empty entries, `sources.trajectory.state === "missing"`, no error.
- Audit sink `.query` throws → `sources.audit.state === "error"`, other sources still populated.
- `query` returns entries for a different session → trust the caller's sink. Document that mixing is a sink bug, not a ledger bug.
- Clock skew: audit `timestamp` predates earliest trajectory `timestamp` → sort places audit first. Document: ordering is wall-clock only, not causal.
- Multiple `RunReport` results for the same session → pick the one with the largest `duration.completedAt`.
- Audit `query` returns 10k+ entries, trajectory returns 10k+ → document soft ceiling of 50k combined; log warning above that.

### Ordering caveat (must document in `docs/L2/decision-ledger.md`)

The ledger orders entries by **wall-clock timestamp only**. It does not establish causal ordering. When trajectory and audit record the same logical event (e.g., tool call), they may emit at slightly different clocks — the two entries can appear in either order in the timeline. Callers that need causal ordering should use `decisionCorrelationId` metadata on the trajectory step when populated by the adapter.

## Doc → Tests → Code order (CLAUDE.md enforced)

1. **Doc:** `docs/L2/decision-ledger.md` — purpose, types, factory, example, join algorithm, wall-clock ordering caveat, edge-case matrix, explicit "NOT" list.
2. **Tests first (failing):**
   - `types.test.ts` — compile-only assertions on readonly, discriminated union exhaustiveness.
   - `create-decision-ledger.test.ts` — factory contract.
   - `join.test.ts` — happy path: trajectory + audit interleaved; stable sort; timestamp ordering.
   - `sources-status.test.ts` — matrix: each source {present, missing, unqueryable, error}.
   - `sidecar-report.test.ts` — report missing vs single vs multiple (latest picked).
   - `catastrophic.test.ts` — empty sessionId → error result.
   - `large-session.test.ts` — 10k trajectory + 10k audit interleaved; asserts stable, no crash, under a loose time budget.
3. **Code:**
   - `types.ts`
   - `create-decision-ledger.ts` (factory, ~60 LOC)
   - `fetch-sources.ts` (parallel fetch + classification, ~70 LOC)
   - `join.ts` (merge + stable sort, ~40 LOC)
   - `normalize.ts` (sink record → entry wrapper, ~50 LOC)
   - `index.ts` — expose only `createDecisionLedger` + public types. No barrel re-exports per CLAUDE.md.
4. **Refactor:** keep every file < 400 lines, every function < 50 lines.

All unit tests use `bun:test`. Fakes for the three sink interfaces (< 40 LOC each) live in `__tests__/fakes.ts`.

## Runtime wiring (minimum honest version)

CLAUDE.md requires every new L2 to be wired into `@koi/runtime` with golden query coverage. Today's replay harness cannot assert the four-way join (see "Golden query constraint" below). Honest version:

1. **Add `@koi/lib/decision-ledger` as a `@koi/runtime` dep** — `packages/meta/runtime/package.json` + `tsconfig.json`.
2. **Expose a builder on `RuntimeHandle`** — `runtime.createDecisionLedger(): DecisionLedgerReader` that pulls the live `trajectoryStore` plus optional `auditSink` / `reportStore` the runtime was constructed with. ~20 LOC.
3. **Standalone golden queries** (no LLM needed) — add 2 describe blocks in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` under `describe("Golden: @koi/decision-ledger", ...)`:
   - `ledger-trajectory-plus-audit-interleave`: fake trajectory with 3 steps + fake audit with 2 entries → assert merged order, sources present.
   - `ledger-all-sinks-unqueryable`: only trajectory present, audit undefined, report undefined → assert degraded sources, entries still correct.
4. **CI gates:** `check:orphans`, `check:golden-queries`, `test --filter=@koi/runtime`, `test --filter=@koi/lib/decision-ledger`, `typecheck`, `check:layers`, `lint`.

### Golden query constraint (explicit)

Today's `packages/meta/runtime/scripts/record-cassettes.ts:886-897` builds the permissions middleware WITHOUT an `auditSink`, and the traced middleware list at `1075-1085` does not include report middleware or a report store. Additionally:
- Denial tracker state is cleared on `onSessionEnd` (`packages/security/middleware-permissions/src/middleware.ts:1063-1075`).
- `RunReport` is only finalized on `onSessionEnd` (`packages/lib/middleware-report/src/report.ts:338-381`).

So a replay-driven "record a cassette, replay it, then call getLedger and assert the timeline" assertion is not possible without extending the recorder and the replay lifecycle. That work is out of scope for Phase 2(a). Document as a follow-up in the PR description.

## PR shape

Single PR, under CLAUDE.md's 300-LOC logic-change cap:

| Part | Est. LOC | Files |
|------|----------|-------|
| `@koi/lib/decision-ledger` package source | ~220 | 5 source files + types |
| Unit tests (7 files, fakes) | ~350 (test lines don't count against cap) | `__tests__/*` |
| `docs/L2/decision-ledger.md` | ~180 | docs only |
| `@koi/runtime` wiring + 2 standalone golden queries | ~80 | runtime handle delta + test additions |

Total logic LOC ~300. Under cap. One PR, reviewable.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ledger is shipped but no production consumer has an audit sink configured, so it looks broken in practice | High | Document in `docs/L2/decision-ledger.md` that audit surfacing requires a configured `AuditSink` with `query()` support. File follow-up issue for default audit sink impl (adjacent to #1627). |
| Wall-clock ordering surprises callers when trajectory/audit emit out-of-order | Medium | Document the caveat prominently. Include an example in the doc showing the same logical event recorded in each sink. |
| 50k-entry soft ceiling hit by long sessions | Low | Warning log only. Pagination is explicitly out of scope — add it when a real caller trips the limit. |
| Stable sort assumption | None | ES2019 guarantees it. Bun runtime is ES2023+. Safe. |
| `ReportStore.getBySession` may be sync or async | None | Types already model `T | Promise<T>`. `await` handles both. |
| Catastrophic error shape diverges from rest of codebase | Low | Use existing `@koi/core` error codes (`VALIDATION`, `INTERNAL`) with `RETRYABLE_DEFAULTS`. Match patterns already in PR #1592. |
| `DecisionLedger` name is rejected as vocab creep | Low | Keep; it's the issue's own language and this is a read-only projection, not a core extension point. Fallback name: `SessionTimeline`. |

## Follow-up issues to file after this PR lands

1. **Default v2 `AuditSink` implementation** (Nexus-backed, queryable). Unblocks production use of the ledger. Adjacent to #1627 audit logging.
2. **Default v2 `ReportStore` implementation**. Unblocks the ledger's sidecar report surface.
3. **Replay lifecycle hooks** — post-session inspection API in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` so Phase 2(a) can graduate to a real replay-driven golden query.
4. **Phase 2 part (b): cross-session decision index** — blocked on porting `@koi/search-nexus` from v1 archive.
5. **Phase 3: graph capability** — Nexus RecordStore adapter + context graph materialization.

## Verification checklist

- [ ] Doc written and committed first
- [ ] Failing tests written second
- [ ] All unit tests pass (`bun run test --filter=@koi/lib/decision-ledger`)
- [ ] `bun run typecheck` clean
- [ ] `bun run check:layers` passes (L2 → L0 only)
- [ ] `bun run check:orphans` passes (wired to runtime)
- [ ] `bun run check:golden-queries` passes (2 standalone golden queries present)
- [ ] `bun run test --filter=@koi/runtime` passes
- [ ] Every file < 400 LOC, every function < 50 LOC
- [ ] PR description links #1469, explicitly scopes to Phase 2(a), lists the 5 follow-up issues above
- [ ] No import from any L2 package in `@koi/lib/decision-ledger/src/**`
- [ ] No new `AuditEntry.kind` added
- [ ] No changes to `DenialTracker` or permissions middleware

## Open questions for user

1. **Name.** Keep `createDecisionLedger` / `DecisionLedger`, or switch to `createSessionTimeline` / `SessionTimeline` to sidestep vocab-creep concern? *Recommend keep — matches issue language.*
2. **Report sidecar.** Ship the `runReport?` sidecar now, or drop it to Phase 2(a') since there's no default `ReportStore` either? *Recommend ship — zero cost, interface is stable, consumer just gets `undefined` until a store exists.*
3. **Ledger location.** `packages/lib/decision-ledger/` vs `packages/sec/decision-ledger/`? *Recommend `lib` — data sources span more than security.*
