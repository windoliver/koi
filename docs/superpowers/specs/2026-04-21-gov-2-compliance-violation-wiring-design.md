# gov-2 follow-up — ComplianceRecorder + ViolationStore wiring

**Issue**: [#1393](https://github.com/windoliver/koi/issues/1393)
**Date**: 2026-04-21
**Layer**: L0 schema bump + L2 (governance-defaults, new violation-store-sqlite) + L3 meta-wiring (runtime-factory, governance-bridge)

## Motivation

PR [#1938](https://github.com/windoliver/koi/pull/1938) (gov-9) shipped the TUI governance surface but left three acceptance items for this issue:

1. `ComplianceRecorder` is always `undefined` on `GovernanceBackend.compliance`, so per-call audit envelopes from `@koi/governance-core` silently no-op.
2. `/governance` view shows only in-memory violations; no persisted history across restarts.
3. `onUsage` callback — **explicitly deferred** by gov-9 review, not part of this spec.

Items (1) and (2) close the governance audit loop: every policy verdict gets recorded through existing audit sinks, every denied verdict gets indexed in a queryable store.

## Scope

**In scope**:
- L0: add `compliance_event` to `AuditEntry.kind` union (audit-backend.ts).
- New: `createAuditSinkComplianceRecorder` in `@koi/governance-defaults` (sink-agnostic mapper).
- New L2 package: `@koi/violation-store-sqlite` (append-only SQLite store + query).
- Wiring: `runtime-factory.ts` auto-wraps audit sinks with the recorder; new `violationSqlitePath` config field plumbs the store into `GovernanceBackend.violations`.
- Bridge: `governance-bridge.ts` accepts optional `ViolationStore`, adds `loadRecentViolations(n)`.
- Docs: new `docs/L2/violation-store-sqlite.md`; updates to governance-defaults, audit-sink-*, and architecture docs.

**Out of scope**:
- `onUsage` consumer (deferred per #1938 review).
- SQLite retention/rotation policy (handled by ops; store is append-only).
- ViolationStore backends other than SQLite (in-memory already exists in archive/v1).

## Design decisions

| # | Decision | Chosen | Alternatives considered |
|---|----------|--------|-------------------------|
| 1 | All three follow-ups in one PR vs phased | One PR | Two smaller PRs — rejected: wiring is cleaner done once |
| 2 | ViolationStore package placement | New `@koi/violation-store-sqlite` | Fold into audit-sink-sqlite or governance-defaults — rejected: broadens those packages' scope |
| 3 | ComplianceRecorder placement | `@koi/governance-defaults` | New package or per-sink variants — rejected: pure mapper, no justification for new package |
| 4 | `AuditEntry.kind` for compliance | New `compliance_event` | Reuse `permission_decision` — rejected: distinct event stream, schema_version gate already supports bumps |
| 5 | Runtime flags | Auto-wire compliance, separate `--violation-sqlite` flag | All-auto or all-opt-in — rejected: matches existing `--audit-*` flag pattern |
| 6 | Bridge backfill | Pass `ViolationStore` to bridge (optional) | Parallel JSONL tail file — rejected: duplicates writes, SQLite query is cheap |

## Architecture

### L0 schema change

`packages/kernel/core/src/audit-backend.ts`:

```diff
 readonly kind:
   | "model_call"
   | "tool_call"
   | "session_start"
   | "session_end"
   | "secret_access"
   | "permission_decision"
+  | "compliance_event"
   | "config_change";
```

Schema version constant in `@koi/middleware-audit` bumps from current → next. Readers already gate on `schema_version`; unknown kinds must not break old readers (they read the field, no enum narrowing).

### `@koi/governance-defaults` — ComplianceRecorder

New file `packages/security/governance-defaults/src/compliance-recorder.ts`:

```typescript
import type { AuditSink, AuditEntry } from "@koi/core";
import type { ComplianceRecord, ComplianceRecorder } from "@koi/core";

export interface AuditSinkComplianceRecorderCtx {
  readonly sessionId: string;
  readonly schemaVersion?: number | undefined;  // default: current
  readonly onError?: ((err: unknown) => void) | undefined;  // default: console.warn
}

export function createAuditSinkComplianceRecorder(
  sink: AuditSink,
  ctx: AuditSinkComplianceRecorderCtx,
): ComplianceRecorder;
```

Mapping rules (`ComplianceRecord` → `AuditEntry`):
- `timestamp` ← `record.evaluatedAt`
- `sessionId` ← `ctx.sessionId`
- `agentId` ← `record.request.agentId`
- `turnIndex` ← `0` (compliance events are not turn-scoped)
- `kind` ← `"compliance_event"`
- `request` ← `record.request`
- `response` ← `record.verdict`
- `durationMs` ← `0`
- `metadata` ← `{ requestId: record.requestId, policyFingerprint: record.policyFingerprint }`

`recordCompliance()` returns the original `ComplianceRecord` unchanged (per L0 contract) and fires `sink.log()` without awaiting. Any rejection is forwarded to `ctx.onError` (default: `console.warn`). The recorder MUST NOT throw back into the governance hot path.

Exported from `packages/security/governance-defaults/src/index.ts`.

### `@koi/violation-store-sqlite` — new L2 package

Structure mirrors `@koi/audit-sink-sqlite`:

```
packages/security/violation-store-sqlite/
├── package.json          (deps: @koi/core, @koi/errors)
├── tsconfig.json
├── tsup.config.ts
├── README.md
└── src/
    ├── index.ts          (public exports)
    ├── config.ts         (SqliteViolationStoreConfig + validator)
    ├── schema.ts         (CREATE TABLE, indexes, insert stmt)
    ├── sqlite-store.ts   (factory + ViolationStore impl)
    ├── config.test.ts
    ├── schema.test.ts
    └── sqlite-store.test.ts
```

**Schema** (`schema.ts`):

```sql
CREATE TABLE IF NOT EXISTS violations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      INTEGER NOT NULL,
  rule           TEXT    NOT NULL,
  severity       TEXT    NOT NULL,
  message        TEXT    NOT NULL,
  context_json   TEXT,
  agent_id       TEXT    NOT NULL,
  session_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_violations_ts       ON violations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_violations_agent_ts ON violations(agent_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_violations_sev_ts   ON violations(severity, timestamp DESC);
PRAGMA journal_mode = WAL;
```

Append-only: no UPDATE/DELETE statements anywhere in the package. A unit test asserts the source contains no `UPDATE violations` or `DELETE FROM violations` substrings.

**Config** (`config.ts`):

```typescript
export interface SqliteViolationStoreConfig {
  readonly dbPath: string;                  // ":memory:" allowed for tests
  readonly flushIntervalMs?: number;        // default: 2000
  readonly maxBufferSize?: number;          // default: 100
}

export function validateSqliteViolationStoreConfig(
  config: unknown,
): Result<SqliteViolationStoreConfig, KoiError>;
```

**Store factory** (`sqlite-store.ts`):

```typescript
export function createSqliteViolationStore(
  config: SqliteViolationStoreConfig,
): ViolationStore & {
  readonly record: (
    violation: Violation,
    agentId: AgentId,
    sessionId: string | undefined,
    timestamp: number,
  ) => void;                               // buffered append
  readonly flush: () => void;
  readonly close: () => void;
};
```

`getViolations(filter: ViolationFilter)` implementation:
- `flush()` first so recent writes are queryable.
- Build WHERE clauses from filter fields (all optional).
- Severity filter uses `VIOLATION_SEVERITY_ORDER` — rows with severity index ≥ filter's index match.
- Cursor: opaque Base64 of last-seen `id` (descending time order). `offset` is parsed as integer `id < N`.
- `limit` defaults to `DEFAULT_VIOLATION_QUERY_LIMIT` (100).
- Returns `ViolationPage` with `items`, optional `cursor` (when more rows exist), optional `total` via `SELECT COUNT(*)` on the same filter.

Row → `Violation` mapping: all DB fields validated like `audit-sink-sqlite/src/sqlite-sink.ts` (`isString`/`isNumber`/`isNullableString`). `context_json` → `Violation.context` via `JSON.parse`.

### Runtime wiring

`packages/meta/cli/src/runtime-factory.ts`:

1. **Config surface** — add `readonly violationSqlitePath?: string | undefined` alongside `auditNdjsonPath` / `auditSqlitePath`.

2. **Audit sink wrapping** — after each audit sink is created (lines ~2095 for NDJSON, ~2151 for SQLite), build a ComplianceRecorder:
   ```typescript
   const complianceRecorder = createAuditSinkComplianceRecorder(auditSink, { sessionId });
   ```
   Collect into a local array `complianceRecorders`. When the array has 2+ entries (both sinks active), wrap in a tiny fan-out recorder defined in `governance-defaults`:
   ```typescript
   export function fanOutComplianceRecorder(
     recorders: readonly ComplianceRecorder[],
   ): ComplianceRecorder;
   ```
   Single-entry arrays pass through directly. Zero-entry means no recorder — `compliance` stays `undefined` on the backend.

3. **Violation store** — when `config.violationSqlitePath` is set, create it:
   ```typescript
   const violationStore = createSqliteViolationStore({ dbPath: config.violationSqlitePath });
   ```
   Register `violationStore.close()` on shutdown.

4. **GovernanceBackend assembly** — at line ~2251, merge optional sub-interfaces:
   ```typescript
   const governanceBackend = baseBackend && (complianceRecorder || violationStore)
     ? { ...baseBackend, compliance: complianceRecorder, violations: violationStore }
     : baseBackend;
   ```

5. **Bridge wiring** — pass `violationStore` into `createGovernanceBridge`.

6. **onViolation callback** — inside `createGovernanceMiddleware` callback wiring (existing), add a sibling that calls `violationStore.record(...)` when set. Runs alongside the existing bridge `recordViolation`.

### Governance bridge

`packages/meta/cli/src/governance-bridge.ts`:

```diff
 export interface GovernanceBridgeConfig {
   // ... existing fields
+  readonly violationStore?: ViolationStore | undefined;
 }

 export interface GovernanceBridge {
   // ... existing methods
+  readonly loadRecentViolations: (n: number) => Promise<readonly Violation[]>;
 }
```

Implementation:

```typescript
async function loadRecentViolations(n: number): Promise<readonly Violation[]> {
  if (config.violationStore === undefined) return [];
  try {
    const page = await config.violationStore.getViolations({ sessionId, limit: n });
    return page.items;
  } catch (err) {
    console.warn("governance-bridge: loadRecentViolations failed", err);
    return [];
  }
}
```

Note: `loadRecentAlerts` is sync (reads a JSONL tail file); `loadRecentViolations` is async because the store contract returns `T | Promise<T>`. TUI callers must `await` — an existing pattern in the bridge for other async operations.

## Data flow

**Allow path:**
```
engine → governance-middleware → backend.evaluator → verdict.ok === true
                              ↓
                 backend.compliance?.recordCompliance()
                              ↓
                 AuditSinkComplianceRecorder → AuditSink.log()
                              ↓
                 NDJSON/SQLite ← "compliance_event" row
```

**Deny path (adds violation indexing):**
```
engine → governance-middleware → backend.evaluator → verdict.ok === false
                              ↓
                 backend.compliance?.recordCompliance()   (same as allow)
                              ↓
                 for each violation:
                   - governance-bridge.recordViolation()  (existing, in-memory)
                   - violationStore.record()              (new, SQLite)
```

**Query path:**
```
TUI /governance → bridge.loadRecentViolations(n)
                              ↓
                 violationStore.getViolations({ sessionId, limit: n })
                              ↓
                 indexed SQLite SELECT
```

## Error handling

| Failure mode | Behavior |
|--------------|----------|
| `sink.log()` rejects inside recorder | `ctx.onError(err)` (default: `console.warn`). Never throws. |
| `violationStore.record()` buffer overflow | Synchronous flush. Same safety as `audit-sink-sqlite`. |
| `violationStore.getViolations()` DB error | Rethrows. Bridge catches and degrades to `[]`. |
| Corrupted DB on startup | Bun's `bun:sqlite` surfaces the error; store creation throws. Runtime-factory lets it propagate (fail-fast on bad config). |
| `violationSqlitePath` set but directory missing | Bun auto-creates the file; parent dir must exist. Validator in `config.ts` does NOT check fs (consistent with `audit-sink-sqlite`). |

## Testing

Following CLAUDE.md Doc→Tests→Code order.

**Unit tests** (colocated `*.test.ts`):

- `governance-defaults/compliance-recorder.test.ts`:
  - Mapping correctness: every `ComplianceRecord` field lands in expected `AuditEntry` slot.
  - `kind === "compliance_event"`.
  - `sessionId` from ctx is applied, not from request.
  - Sink rejection invokes `onError`, does not throw.
  - Default `onError` is `console.warn` (spy).

- `violation-store-sqlite/sqlite-store.test.ts`:
  - Write + read roundtrip (single violation).
  - All filter dimensions: `agentId`, `sessionId`, `severity` (at-or-above), `rule`, `since`, `until`, `limit`, `offset` cursor pagination.
  - Concurrent writes safe — two stores opened on same WAL DB file, interleaved writes, reader sees both.
  - `close()` flushes buffer before closing.
  - Reopen file: data persists, new rows append.
  - Corrupted row: `validateRow` throws descriptive error.

- `violation-store-sqlite/schema.test.ts`:
  - Source file contains zero `UPDATE violations` / `DELETE FROM violations` substrings (append-only invariant).
  - All three indexes are created on fresh DB.

- `violation-store-sqlite/config.test.ts`:
  - Validator accepts minimal config.
  - Validator rejects missing `dbPath`, non-positive intervals.

- `governance-bridge.test.ts` (existing file, new cases):
  - `loadRecentViolations(5)` returns `[]` when `violationStore` undefined.
  - `loadRecentViolations(5)` queries store with current sessionId + limit.
  - Store throw → returns `[]`, logs warn.

**Integration test**:

`runtime-factory.test.ts` (existing file, new case):
- Construct runtime with `auditSqlitePath` + `violationSqlitePath`.
- Feed a synthetic policy request that denies.
- Assert: audit DB has a `compliance_event` row; violation DB has a row matching the denied rule.

**Golden query coverage** (per CLAUDE.md L2 rule):
- Wire `@koi/violation-store-sqlite` as dep of `@koi/runtime` in `packages/meta/runtime/package.json` + `tsconfig.json`.
- Add golden replay assertion for `permission-deny` query: running with a `violationSqlitePath` set, after replay finishes, `getViolations({ sessionId, limit: 10 })` returns exactly one violation with the expected `rule`.
- No new cassette needed — reuse existing `permission-deny` cassette.

## Docs

- **New**: `docs/L2/violation-store-sqlite.md` — package overview, config, schema, query examples, append-only guarantee.
- **Update**: `docs/L2/governance-defaults.md` — add `createAuditSinkComplianceRecorder` section.
- **Update**: `docs/L2/audit-sink-ndjson.md` + `docs/L2/audit-sink-sqlite.md` — note that `compliance_event` kind now flows through these sinks when compliance recording is enabled.
- **Update**: `docs/architecture/governance-backend.md` — wiring diagram showing sink → recorder → backend.compliance.

## LOC budget

| File | LOC |
|------|-----|
| L0 `audit-backend.ts` diff | +1 |
| `governance-defaults/compliance-recorder.ts` | ~100 (includes `fanOutComplianceRecorder`) |
| `governance-defaults/compliance-recorder.test.ts` | ~140 |
| `violation-store-sqlite/src/*` | ~300 |
| `violation-store-sqlite/**/*.test.ts` | ~300 |
| `runtime-factory.ts` edits | ~60 |
| `governance-bridge.ts` edits | ~40 |
| `governance-bridge.test.ts` additions | ~60 |
| Integration test additions | ~80 |
| Golden replay assertions | ~30 |
| Docs | ~200 |
| **Total** | **~1310** |

Under the 1500-LOC PR cap. If review latency is a concern, ComplianceRecorder + wiring can split from ViolationStore + wiring into two PRs (~600 each).

## Anti-leak checklist

- [x] L0 change is pure type addition (union member).
- [x] No framework-isms introduced.
- [x] L2 packages depend only on `@koi/core` + `@koi/errors` (for violation-store-sqlite) / `@koi/core` (for governance-defaults).
- [x] No `@koi/engine` import from any L2.
- [x] All interface properties `readonly`.
- [x] Store returns `T | Promise<T>` — sync `getViolations` is fine, L0 contract allows it.
- [x] Append-only contract enforced by test.

## CI gate

```bash
bun run typecheck
bun run lint
bun run test
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run check:orphans          # violation-store-sqlite must be dep of @koi/runtime
bun run check:golden-queries   # permission-deny must assert violation row
```

## Follow-ups (explicitly NOT in this PR)

1. `onUsage` streaming consumer (deferred per #1938 review).
2. Violation retention policy / rotation (ops concern, append-only DB).
3. NDJSON-backed ViolationStore variant (YAGNI until a use case appears).
4. CLI command to dump compliance events / violations (future operator UX).
