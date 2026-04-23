# gov-2 ComplianceRecorder + ViolationStore Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the governance audit loop left by gov-9 (#1938): ship an audit-sink-backed `ComplianceRecorder`, a SQLite-backed `ViolationStore`, and wire both into `runtime-factory` and `governance-bridge` so every policy verdict is recorded and `/governance` can backfill violation history.

**Architecture:** Three additive changes: (1) extend the L0 `AuditEntry.kind` union with `compliance_event`; (2) add `createAuditSinkComplianceRecorder` + `fanOutComplianceRecorder` in `@koi/governance-defaults` as pure `AuditSink` mappers; (3) a new L2 package `@koi/violation-store-sqlite` with WAL-mode SQLite, append-only schema, buffered writes, and indexed queries. Wiring in `runtime-factory.ts` auto-wraps audit sinks with the recorder and gates the store behind a new `violationSqlitePath` flag.

**Tech Stack:** Bun 1.3.x, `bun:sqlite` (WAL mode), `bun:test`, tsup, TypeScript 6 (strict, `isolatedDeclarations`), Biome.

**Spec:** `docs/superpowers/specs/2026-04-21-gov-2-compliance-violation-wiring-design.md`

---

## File Structure

**New files:**
- `packages/security/governance-defaults/src/compliance-recorder.ts` — `createAuditSinkComplianceRecorder` + `fanOutComplianceRecorder`
- `packages/security/governance-defaults/src/compliance-recorder.test.ts`
- `packages/security/violation-store-sqlite/package.json`
- `packages/security/violation-store-sqlite/tsconfig.json`
- `packages/security/violation-store-sqlite/tsup.config.ts`
- `packages/security/violation-store-sqlite/README.md`
- `packages/security/violation-store-sqlite/src/index.ts`
- `packages/security/violation-store-sqlite/src/config.ts`
- `packages/security/violation-store-sqlite/src/config.test.ts`
- `packages/security/violation-store-sqlite/src/schema.ts`
- `packages/security/violation-store-sqlite/src/schema.test.ts`
- `packages/security/violation-store-sqlite/src/sqlite-store.ts`
- `packages/security/violation-store-sqlite/src/sqlite-store.test.ts`
- `docs/L2/violation-store-sqlite.md`

**Modified files:**
- `packages/kernel/core/src/audit-backend.ts` — add `compliance_event` to `kind` union
- `packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap` — regenerated
- `packages/security/governance-defaults/src/index.ts` — export new recorder factories
- `docs/L2/governance-defaults.md` — document recorder factories
- `docs/L2/audit-sink-ndjson.md` — note `compliance_event` kind
- `docs/L2/audit-sink-sqlite.md` — note `compliance_event` kind
- `docs/architecture/governance-backend.md` — wiring diagram
- `packages/meta/cli/src/runtime-factory.ts` — config field + sink wrapping + backend assembly
- `packages/meta/cli/src/runtime-factory.test.ts` — integration test
- `packages/meta/cli/src/governance-bridge.ts` — optional `violationStore` + `loadRecentViolations`
- `packages/meta/cli/src/governance-bridge.test.ts` — new cases
- `packages/meta/runtime/package.json` — add `@koi/violation-store-sqlite` dep
- `packages/meta/runtime/tsconfig.json` — add project reference
- `packages/meta/runtime/src/__tests__/golden-replay.test.ts` — violation assertion

---

## Task 1: L0 Schema — Add `compliance_event` Kind

**Files:**
- Modify: `packages/kernel/core/src/audit-backend.ts:17-24`
- Regenerate: `packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap`

- [ ] **Step 1: Update the kind union**

Edit `packages/kernel/core/src/audit-backend.ts`, add `"compliance_event"` to the `AuditEntry.kind` union between `"permission_decision"` and `"config_change"`:

```typescript
readonly kind:
  | "model_call"
  | "tool_call"
  | "session_start"
  | "session_end"
  | "secret_access"
  | "permission_decision"
  | "compliance_event"
  | "config_change";
```

- [ ] **Step 2: Run core tests to confirm snapshot mismatch**

Run: `bun test --cwd packages/kernel/core api-surface`
Expected: FAIL — snapshot mismatch on `AuditEntry.kind` union line.

- [ ] **Step 3: Regenerate snapshot**

Run: `bun test --cwd packages/kernel/core api-surface -u`
Expected: PASS. Snapshot updates with `compliance_event` in the union.

- [ ] **Step 4: Typecheck core**

Run: `bun run --cwd packages/kernel/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/core/src/audit-backend.ts \
        packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap
git commit -m "feat(#1393): add compliance_event to AuditEntry.kind (L0)"
```

---

## Task 2: Documentation — `governance-defaults` Recorder Section

**Files:**
- Modify: `docs/L2/governance-defaults.md`

- [ ] **Step 1: Add the ComplianceRecorder section**

Append a new section to `docs/L2/governance-defaults.md`:

```markdown
## Audit-Sink-Backed ComplianceRecorder

`createAuditSinkComplianceRecorder(sink, ctx)` wraps any `AuditSink`
(NDJSON, SQLite, Nexus) so that governance compliance records flow into the
same audit stream as model and tool calls. Each `ComplianceRecord` is mapped
to an `AuditEntry` with `kind: "compliance_event"`.

### Factory

```ts
import { createAuditSinkComplianceRecorder } from "@koi/governance-defaults";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";

const sink = createNdjsonAuditSink({ filePath: "/tmp/audit.ndjson" });
const compliance = createAuditSinkComplianceRecorder(sink, {
  sessionId: "sess-abc",
});

backend.compliance = compliance;
```

### Mapping

| `ComplianceRecord` field | `AuditEntry` field |
|--------------------------|--------------------|
| `evaluatedAt`            | `timestamp`        |
| (ctx) `sessionId`        | `sessionId`        |
| `request.agentId`        | `agentId`          |
| (constant `0`)           | `turnIndex`        |
| (constant `"compliance_event"`) | `kind`      |
| `request`                | `request`          |
| `verdict`                | `response`         |
| (constant `0`)           | `durationMs`       |
| `{ requestId, policyFingerprint }` | `metadata` |

### Error handling

`recordCompliance()` returns the original record synchronously and fires
`sink.log()` without awaiting. Rejections are routed to `ctx.onError` (default
`console.warn`). The recorder never throws into the governance hot path.

### Fan-out

When multiple audit sinks are active, compose their recorders with
`fanOutComplianceRecorder([a, b])`. Single-entry arrays pass through. Empty
arrays return a no-op recorder.
```

- [ ] **Step 2: Commit**

```bash
git add docs/L2/governance-defaults.md
git commit -m "docs(#1393): add ComplianceRecorder section to governance-defaults"
```

---

## Task 3: Documentation — `violation-store-sqlite` L2 Doc

**Files:**
- Create: `docs/L2/violation-store-sqlite.md`

- [ ] **Step 1: Create the doc**

Write `docs/L2/violation-store-sqlite.md`:

```markdown
# @koi/violation-store-sqlite

Append-only SQLite-backed implementation of `ViolationStore` (L0 contract in
`@koi/core/governance-backend`). Indexed by timestamp, agent, and severity for
the `/governance` history view.

## Scope

One sentence: persists governance violations to SQLite for history queries.

## Install / layer

- Layer: L2
- Depends on: `@koi/core`, `@koi/errors`
- Consumers: `@koi/runtime` (dep), `packages/meta/cli/src/runtime-factory.ts` (wiring)

## Config

```ts
interface SqliteViolationStoreConfig {
  readonly dbPath: string;           // ":memory:" allowed in tests
  readonly flushIntervalMs?: number; // default 2000
  readonly maxBufferSize?: number;   // default 100
}
```

## Factory

```ts
import { createSqliteViolationStore } from "@koi/violation-store-sqlite";

const store = createSqliteViolationStore({ dbPath: "/var/koi/violations.db" });

store.record(violation, agentId, sessionId, Date.now());
const page = await store.getViolations({ sessionId, limit: 50 });
```

## Schema

| Column         | Type    | Notes                                  |
|----------------|---------|----------------------------------------|
| `id`           | INTEGER | AUTOINCREMENT primary key              |
| `timestamp`    | INTEGER | UNIX ms                                |
| `rule`         | TEXT    | Violation rule id                      |
| `severity`     | TEXT    | `info` / `warning` / `critical`        |
| `message`      | TEXT    | Human-readable                         |
| `context_json` | TEXT    | Nullable, JSON of `Violation.context`  |
| `agent_id`     | TEXT    | Acting agent                           |
| `session_id`   | TEXT    | Nullable (agent-scoped violations)     |

Indexes: `(timestamp DESC)`, `(agent_id, timestamp DESC)`, `(severity, timestamp DESC)`.

WAL mode is enabled via `PRAGMA journal_mode = WAL`.

## Append-only guarantee

No `UPDATE` or `DELETE` SQL statements exist in the package. A unit test
asserts the source contains no such substrings. Administrators who need to
truncate the DB must drop and recreate the file.

## Filters

`getViolations(filter)` supports:
- `agentId`, `sessionId`, `rule` — exact match
- `severity` — at-or-above, using `VIOLATION_SEVERITY_ORDER`
- `since`, `until` — inclusive/exclusive timestamp bounds
- `limit` — defaults to `DEFAULT_VIOLATION_QUERY_LIMIT` (100)
- `offset` — opaque cursor encoding the last-seen `id`

Returns `ViolationPage { items, cursor?, total? }`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/L2/violation-store-sqlite.md
git commit -m "docs(#1393): add L2 doc for violation-store-sqlite"
```

---

## Task 4: `governance-defaults` — ComplianceRecorder Test (failing)

**Files:**
- Create: `packages/security/governance-defaults/src/compliance-recorder.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, spyOn, test } from "bun:test";
import type {
  AuditEntry,
  AuditSink,
  ComplianceRecord,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core";
import { agentId } from "@koi/core";
import {
  createAuditSinkComplianceRecorder,
  fanOutComplianceRecorder,
} from "./compliance-recorder.js";

function makeRecord(overrides?: Partial<ComplianceRecord>): ComplianceRecord {
  const request: PolicyRequest = {
    kind: "tool_call",
    agentId: agentId("agent-1"),
    payload: { tool: "bash" },
    timestamp: 1_700_000_000_000,
  };
  const verdict: GovernanceVerdict = { ok: true };
  return {
    requestId: "req-1",
    request,
    verdict,
    evaluatedAt: 1_700_000_000_500,
    policyFingerprint: "v1:abcd",
    ...overrides,
  };
}

function makeSink(): AuditSink & { readonly logs: AuditEntry[] } {
  const logs: AuditEntry[] = [];
  return {
    log: async (entry: AuditEntry): Promise<void> => {
      logs.push(entry);
    },
    logs,
  };
}

describe("createAuditSinkComplianceRecorder", () => {
  test("maps ComplianceRecord to AuditEntry with compliance_event kind", async () => {
    const sink = makeSink();
    const recorder = createAuditSinkComplianceRecorder(sink, {
      sessionId: "sess-xyz",
    });
    const record = makeRecord();

    const returned = await recorder.recordCompliance(record);

    expect(returned).toBe(record);
    expect(sink.logs).toHaveLength(1);
    const entry = sink.logs[0];
    expect(entry?.kind).toBe("compliance_event");
    expect(entry?.sessionId).toBe("sess-xyz");
    expect(entry?.agentId).toBe(record.request.agentId);
    expect(entry?.timestamp).toBe(record.evaluatedAt);
    expect(entry?.turnIndex).toBe(0);
    expect(entry?.durationMs).toBe(0);
    expect(entry?.request).toEqual(record.request);
    expect(entry?.response).toEqual(record.verdict);
    expect(entry?.metadata).toEqual({
      requestId: "req-1",
      policyFingerprint: "v1:abcd",
    });
  });

  test("ignores sessionId on request — always uses ctx.sessionId", async () => {
    const sink = makeSink();
    const recorder = createAuditSinkComplianceRecorder(sink, {
      sessionId: "ctx-session",
    });
    await recorder.recordCompliance(
      makeRecord({
        request: {
          ...makeRecord().request,
          payload: { sessionId: "payload-session" },
        },
      }),
    );
    expect(sink.logs[0]?.sessionId).toBe("ctx-session");
  });

  test("sink rejection invokes onError, does not throw", async () => {
    const failing: AuditSink = {
      log: async () => {
        throw new Error("disk full");
      },
    };
    let seen: unknown;
    const recorder = createAuditSinkComplianceRecorder(failing, {
      sessionId: "sess-1",
      onError: (err) => {
        seen = err;
      },
    });

    // Must not throw
    const result = await recorder.recordCompliance(makeRecord());
    expect(result).toBeDefined();
    // Give microtask queue a chance to flush the swallowed rejection
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBeInstanceOf(Error);
    expect((seen as Error).message).toBe("disk full");
  });

  test("default onError is console.warn", async () => {
    const failing: AuditSink = {
      log: async () => {
        throw new Error("boom");
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorder = createAuditSinkComplianceRecorder(failing, {
        sessionId: "sess-1",
      });
      await recorder.recordCompliance(makeRecord());
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("fanOutComplianceRecorder", () => {
  test("zero recorders returns a no-op that still returns the record", async () => {
    const recorder = fanOutComplianceRecorder([]);
    const rec = makeRecord();
    expect(await recorder.recordCompliance(rec)).toBe(rec);
  });

  test("single recorder is passed through (no wrapper allocation)", async () => {
    const sink = makeSink();
    const inner = createAuditSinkComplianceRecorder(sink, { sessionId: "s" });
    const outer = fanOutComplianceRecorder([inner]);
    expect(outer).toBe(inner);
  });

  test("multi-recorder writes to every sink", async () => {
    const a = makeSink();
    const b = makeSink();
    const outer = fanOutComplianceRecorder([
      createAuditSinkComplianceRecorder(a, { sessionId: "s" }),
      createAuditSinkComplianceRecorder(b, { sessionId: "s" }),
    ]);
    await outer.recordCompliance(makeRecord());
    expect(a.logs).toHaveLength(1);
    expect(b.logs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test --cwd packages/security/governance-defaults compliance-recorder`
Expected: FAIL — `compliance-recorder.js` does not exist.

---

## Task 5: `governance-defaults` — ComplianceRecorder Implementation

**Files:**
- Create: `packages/security/governance-defaults/src/compliance-recorder.ts`
- Modify: `packages/security/governance-defaults/src/index.ts`

- [ ] **Step 1: Write the module**

```typescript
/**
 * Audit-sink-backed ComplianceRecorder — maps governance ComplianceRecord
 * entries to AuditEntry and forwards to the supplied AuditSink.
 *
 * Errors are swallowed (routed to onError) so a failing sink cannot crash
 * the governance hot path. sink.log() is fire-and-forget.
 */

import type {
  AuditEntry,
  AuditSink,
  ComplianceRecord,
  ComplianceRecorder,
} from "@koi/core";

/** Default AuditEntry.schema_version for compliance events when ctx omits one. */
const DEFAULT_AUDIT_SCHEMA_VERSION = 1;

export interface AuditSinkComplianceRecorderCtx {
  readonly sessionId: string;
  readonly schemaVersion?: number | undefined;
  readonly onError?: ((err: unknown) => void) | undefined;
}

export function createAuditSinkComplianceRecorder(
  sink: AuditSink,
  ctx: AuditSinkComplianceRecorderCtx,
): ComplianceRecorder {
  const schemaVersion = ctx.schemaVersion ?? DEFAULT_AUDIT_SCHEMA_VERSION;
  const onError = ctx.onError ?? ((err: unknown): void => {
    console.warn("[compliance-recorder] sink.log failed:", err);
  });

  return {
    recordCompliance(record: ComplianceRecord): ComplianceRecord {
      const entry: AuditEntry = {
        schema_version: schemaVersion,
        timestamp: record.evaluatedAt,
        sessionId: ctx.sessionId,
        agentId: record.request.agentId,
        turnIndex: 0,
        kind: "compliance_event",
        request: record.request,
        response: record.verdict,
        durationMs: 0,
        metadata: {
          requestId: record.requestId,
          policyFingerprint: record.policyFingerprint,
        },
      };

      // Fire-and-forget — never await, never throw back to caller.
      sink.log(entry).catch(onError);
      return record;
    },
  };
}

/**
 * Compose multiple ComplianceRecorders so one call writes to all of them.
 * - Empty array → no-op recorder (returns the record unchanged).
 * - Single entry → passed through directly (no wrapper allocation).
 * - 2+ → each recorder's recordCompliance is invoked sequentially.
 *
 * Errors inside an individual recorder must be contained by that recorder;
 * fanOut does not catch.
 */
export function fanOutComplianceRecorder(
  recorders: readonly ComplianceRecorder[],
): ComplianceRecorder {
  if (recorders.length === 0) {
    return {
      recordCompliance(record: ComplianceRecord): ComplianceRecord {
        return record;
      },
    };
  }
  if (recorders.length === 1) {
    const sole = recorders[0];
    if (sole === undefined) {
      throw new Error("fanOutComplianceRecorder: unreachable undefined entry");
    }
    return sole;
  }
  return {
    async recordCompliance(record: ComplianceRecord): Promise<ComplianceRecord> {
      for (const r of recorders) {
        await r.recordCompliance(record);
      }
      return record;
    },
  };
}
```

- [ ] **Step 2: Export from index**

Edit `packages/security/governance-defaults/src/index.ts`, add:

```typescript
export type { AuditSinkComplianceRecorderCtx } from "./compliance-recorder.js";
export {
  createAuditSinkComplianceRecorder,
  fanOutComplianceRecorder,
} from "./compliance-recorder.js";
```

- [ ] **Step 3: Run tests**

Run: `bun test --cwd packages/security/governance-defaults compliance-recorder`
Expected: PASS (6 tests).

- [ ] **Step 4: Typecheck + lint**

Run: `bun run --cwd packages/security/governance-defaults typecheck && bun run --cwd packages/security/governance-defaults lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-defaults/src/compliance-recorder.ts \
        packages/security/governance-defaults/src/compliance-recorder.test.ts \
        packages/security/governance-defaults/src/index.ts
git commit -m "feat(#1393): audit-sink-backed ComplianceRecorder + fan-out"
```

---

## Task 6: `@koi/violation-store-sqlite` — Package Scaffold

**Files:**
- Create: `packages/security/violation-store-sqlite/package.json`
- Create: `packages/security/violation-store-sqlite/tsconfig.json`
- Create: `packages/security/violation-store-sqlite/tsup.config.ts`
- Create: `packages/security/violation-store-sqlite/README.md`

- [ ] **Step 1: package.json**

```json
{
  "name": "@koi/violation-store-sqlite",
  "description": "Append-only SQLite-backed ViolationStore with WAL mode and indexed queries",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../kernel/core" }, { "path": "../../lib/errors" }]
}
```

- [ ] **Step 3: tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: ["bun:sqlite"],
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 4: README.md**

```markdown
# @koi/violation-store-sqlite

Append-only SQLite-backed `ViolationStore` for `@koi/governance-core`.

See `docs/L2/violation-store-sqlite.md` for design notes, schema, and wiring.
```

- [ ] **Step 5: Install deps from root to register the new workspace**

Run: `bun install`
Expected: Workspace discovered; `bun.lock` updates with the new package.

- [ ] **Step 6: Commit scaffold**

```bash
git add packages/security/violation-store-sqlite/ bun.lock
git commit -m "feat(#1393): scaffold @koi/violation-store-sqlite package"
```

---

## Task 7: `@koi/violation-store-sqlite` — Config (failing test first)

**Files:**
- Create: `packages/security/violation-store-sqlite/src/config.ts`
- Create: `packages/security/violation-store-sqlite/src/config.test.ts`

- [ ] **Step 1: Write failing config test**

Create `packages/security/violation-store-sqlite/src/config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { validateSqliteViolationStoreConfig } from "./config.js";

describe("validateSqliteViolationStoreConfig", () => {
  test("accepts minimal config", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: "/tmp/v.db" });
    expect(result.ok).toBe(true);
  });

  test("accepts :memory: dbPath", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: ":memory:" });
    expect(result.ok).toBe(true);
  });

  test("accepts full config", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      flushIntervalMs: 1000,
      maxBufferSize: 50,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null", () => {
    const result = validateSqliteViolationStoreConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects missing dbPath", () => {
    const result = validateSqliteViolationStoreConfig({});
    expect(result.ok).toBe(false);
  });

  test("rejects empty dbPath", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive flushIntervalMs", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      flushIntervalMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive maxBufferSize", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      maxBufferSize: -1,
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test --cwd packages/security/violation-store-sqlite config`
Expected: FAIL — `config.js` not found.

- [ ] **Step 3: Implement config.ts**

```typescript
/** Configuration for @koi/violation-store-sqlite. */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

export interface SqliteViolationStoreConfig {
  readonly dbPath: string;
  readonly flushIntervalMs?: number;
  readonly maxBufferSize?: number;
}

function fail(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateSqliteViolationStoreConfig(
  config: unknown,
): Result<SqliteViolationStoreConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return fail("config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  if (typeof c.dbPath !== "string" || c.dbPath.length === 0) {
    return fail("config.dbPath must be a non-empty string");
  }
  if (c.flushIntervalMs !== undefined) {
    if (typeof c.flushIntervalMs !== "number" || c.flushIntervalMs <= 0) {
      return fail("config.flushIntervalMs must be a positive number");
    }
  }
  if (c.maxBufferSize !== undefined) {
    if (typeof c.maxBufferSize !== "number" || c.maxBufferSize <= 0) {
      return fail("config.maxBufferSize must be a positive number");
    }
  }
  return { ok: true, value: config as SqliteViolationStoreConfig };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test --cwd packages/security/violation-store-sqlite config`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/security/violation-store-sqlite/src/config.ts \
        packages/security/violation-store-sqlite/src/config.test.ts
git commit -m "feat(#1393): violation-store-sqlite config + validator"
```

---

## Task 8: `@koi/violation-store-sqlite` — Schema (failing test first)

**Files:**
- Create: `packages/security/violation-store-sqlite/src/schema.ts`
- Create: `packages/security/violation-store-sqlite/src/schema.test.ts`

- [ ] **Step 1: Write failing schema test**

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { initViolationSchema } from "./schema.js";

describe("violations schema", () => {
  test("creates the violations table with required columns", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    const cols = db
      .prepare("PRAGMA table_info('violations')")
      .all() as readonly { readonly name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("timestamp");
    expect(names).toContain("rule");
    expect(names).toContain("severity");
    expect(names).toContain("message");
    expect(names).toContain("context_json");
    expect(names).toContain("agent_id");
    expect(names).toContain("session_id");
  });

  test("creates all three indexes", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='violations'")
      .all() as readonly { readonly name: string }[];
    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_violations_ts");
    expect(names).toContain("idx_violations_agent_ts");
    expect(names).toContain("idx_violations_sev_ts");
  });

  test("initViolationSchema is idempotent", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    initViolationSchema(db); // second call must not throw
  });

  test("source file is append-only (no UPDATE/DELETE against violations)", () => {
    const src = readFileSync(new URL("./schema.ts", import.meta.url), "utf-8");
    const storeSrc = readFileSync(new URL("./sqlite-store.ts", import.meta.url), "utf-8");
    for (const file of [src, storeSrc]) {
      expect(file.toLowerCase()).not.toContain("update violations");
      expect(file.toLowerCase()).not.toContain("delete from violations");
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test --cwd packages/security/violation-store-sqlite schema`
Expected: FAIL — `schema.js` missing and `sqlite-store.ts` missing.

- [ ] **Step 3: Implement schema.ts**

```typescript
/**
 * SQLite schema for the violations table.
 * WAL mode + indexes on timestamp, agent, and severity.
 * Append-only: no UPDATE or DELETE statements live in this package.
 */

import type { Database, Statement } from "bun:sqlite";

const PRAGMA_WAL = "PRAGMA journal_mode = WAL";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS violations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      INTEGER NOT NULL,
    rule           TEXT    NOT NULL,
    severity       TEXT    NOT NULL,
    message        TEXT    NOT NULL,
    context_json   TEXT,
    agent_id       TEXT    NOT NULL,
    session_id     TEXT
  )
`;

const CREATE_IDX_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_ts
  ON violations(timestamp DESC)
`;

const CREATE_IDX_AGENT_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_agent_ts
  ON violations(agent_id, timestamp DESC)
`;

const CREATE_IDX_SEV_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_sev_ts
  ON violations(severity, timestamp DESC)
`;

export function initViolationSchema(db: Database): void {
  db.run(PRAGMA_WAL);
  db.run(CREATE_TABLE);
  db.run(CREATE_IDX_TS);
  db.run(CREATE_IDX_AGENT_TS);
  db.run(CREATE_IDX_SEV_TS);
}

export function createInsertStmt(db: Database): Statement {
  return db.prepare(`
    INSERT INTO violations (
      timestamp, rule, severity, message, context_json, agent_id, session_id
    ) VALUES (
      $timestamp, $rule, $severity, $message, $contextJson, $agentId, $sessionId
    )
  `);
}

export interface ViolationRow {
  readonly id: number;
  readonly timestamp: number;
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
  readonly context_json: string | null;
  readonly agent_id: string;
  readonly session_id: string | null;
}
```

- [ ] **Step 4: Create a placeholder `sqlite-store.ts` so the schema test can run (full impl in next task)**

```typescript
// Placeholder; full implementation lands in the next task.
export {};
```

- [ ] **Step 5: Run schema tests**

Run: `bun test --cwd packages/security/violation-store-sqlite schema`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/security/violation-store-sqlite/src/schema.ts \
        packages/security/violation-store-sqlite/src/schema.test.ts \
        packages/security/violation-store-sqlite/src/sqlite-store.ts
git commit -m "feat(#1393): violation-store-sqlite schema + indexes"
```

---

## Task 9: `@koi/violation-store-sqlite` — Store Impl (failing tests first)

**Files:**
- Create: `packages/security/violation-store-sqlite/src/sqlite-store.test.ts`
- Modify: `packages/security/violation-store-sqlite/src/sqlite-store.ts`

- [ ] **Step 1: Write failing store tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { AgentId, Violation, ViolationSeverity } from "@koi/core";
import { agentId } from "@koi/core";
import { createSqliteViolationStore } from "./sqlite-store.js";

function makeViolation(overrides?: Partial<Violation>): Violation {
  return {
    rule: "max-spawn-depth",
    severity: "warning",
    message: "depth exceeded",
    context: { limit: 3, actual: 4 },
    ...overrides,
  };
}

const A1: AgentId = agentId("agent-1");
const A2: AgentId = agentId("agent-2");

describe("createSqliteViolationStore — basic roundtrip", () => {
  test("record → flush → getViolations returns the entry", async () => {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    store.flush();
    const page = await store.getViolations({ sessionId: "sess-1" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.rule).toBe("max-spawn-depth");
    expect(page.items[0]?.context).toEqual({ limit: 3, actual: 4 });
    store.close();
  });

  test("getViolations auto-flushes pending buffer", async () => {
    const store = createSqliteViolationStore({
      dbPath: ":memory:",
      maxBufferSize: 10_000,
    });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    const page = await store.getViolations({ sessionId: "sess-1" });
    expect(page.items).toHaveLength(1);
    store.close();
  });

  test("close flushes pending buffer and does not throw", async () => {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    // Do not call flush; close should flush.
    expect(() => store.close()).not.toThrow();
  });
});

describe("createSqliteViolationStore — filters", () => {
  async function seed() {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation({ severity: "info", rule: "r1" }), A1, "S", 1_000);
    store.record(makeViolation({ severity: "warning", rule: "r1" }), A1, "S", 2_000);
    store.record(makeViolation({ severity: "critical", rule: "r2" }), A2, "S", 3_000);
    store.record(makeViolation({ severity: "warning", rule: "r2" }), A2, "T", 4_000);
    store.flush();
    return store;
  }

  test("agentId filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ agentId: A1 });
    expect(page.items).toHaveLength(2);
    store.close();
  });

  test("sessionId filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ sessionId: "T" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.rule).toBe("r2");
    store.close();
  });

  test("severity filter (at-or-above)", async () => {
    const store = await seed();
    const page = await store.getViolations({ severity: "warning" });
    // info → out; warning → in; critical → in.
    const sev: ViolationSeverity[] = page.items.map((i) => i.severity);
    expect(sev).not.toContain("info");
    expect(sev.length).toBe(3);
    store.close();
  });

  test("rule filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ rule: "r2" });
    expect(page.items).toHaveLength(2);
    store.close();
  });

  test("since/until time window (inclusive since, exclusive until)", async () => {
    const store = await seed();
    const page = await store.getViolations({ since: 2_000, until: 4_000 });
    expect(page.items).toHaveLength(2); // ts=2000 and ts=3000
    store.close();
  });

  test("limit + cursor pagination", async () => {
    const store = await seed();
    const first = await store.getViolations({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeDefined();

    const second = await store.getViolations({
      limit: 2,
      ...(first.cursor !== undefined ? { offset: first.cursor } : {}),
    });
    expect(second.items).toHaveLength(2);
    // No overlap: first and second pages must be disjoint in id space.
    const ids1 = new Set(first.items.map((i) => i.rule + i.message));
    for (const item of second.items) {
      expect(ids1.has(item.rule + item.message)).toBe(false);
    }
    store.close();
  });
});

describe("createSqliteViolationStore — concurrency + persistence", () => {
  test("persists across reopen of the same file", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vstore-"));
    const dbPath = join(dir, "v.db");
    try {
      const a = createSqliteViolationStore({ dbPath });
      a.record(makeViolation(), A1, "sess", 1_000);
      a.close();

      const b = createSqliteViolationStore({ dbPath });
      const page = await b.getViolations({ sessionId: "sess" });
      expect(page.items).toHaveLength(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent writers on the same WAL DB do not error", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vstore-"));
    const dbPath = join(dir, "v.db");
    try {
      const a = createSqliteViolationStore({ dbPath });
      const b = createSqliteViolationStore({ dbPath });
      for (let i = 0; i < 10; i++) {
        a.record(makeViolation({ rule: `a-${i}` }), A1, "S", 1_000 + i);
        b.record(makeViolation({ rule: `b-${i}` }), A2, "S", 2_000 + i);
      }
      a.flush();
      b.flush();
      const page = await a.getViolations({ limit: 100 });
      expect(page.items.length).toBe(20);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test --cwd packages/security/violation-store-sqlite sqlite-store`
Expected: FAIL — `createSqliteViolationStore` is not exported (placeholder file).

- [ ] **Step 3: Implement `sqlite-store.ts`**

```typescript
/**
 * SQLite-backed ViolationStore — buffered appends, WAL-mode reads,
 * indexed filter queries.
 *
 * Append-only: no UPDATE/DELETE SQL. Row bytes are validated before being
 * returned to callers; corrupt rows throw descriptive errors.
 */

import { Database } from "bun:sqlite";
import type {
  AgentId,
  Violation,
  ViolationFilter,
  ViolationPage,
  ViolationSeverity,
  ViolationStore,
} from "@koi/core";
import { DEFAULT_VIOLATION_QUERY_LIMIT, VIOLATION_SEVERITY_ORDER } from "@koi/core";
import type { SqliteViolationStoreConfig } from "./config.js";
import {
  createInsertStmt,
  initViolationSchema,
  type ViolationRow,
} from "./schema.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BUFFER_SIZE = 100;

interface BufferedEntry {
  readonly violation: Violation;
  readonly agentId: AgentId;
  readonly sessionId: string | undefined;
  readonly timestamp: number;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number";
}
function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function validateRow(row: unknown): ViolationRow {
  if (row === null || row === undefined || typeof row !== "object") {
    throw new Error("violations: row must be a non-null object");
  }
  const r = row as Record<string, unknown>;
  if (!isNumber(r.id)) throw new Error("violations: id must be a number");
  if (!isNumber(r.timestamp)) throw new Error("violations: timestamp must be a number");
  if (!isString(r.rule)) throw new Error("violations: rule must be a string");
  if (!isString(r.severity)) throw new Error("violations: severity must be a string");
  if (!isString(r.message)) throw new Error("violations: message must be a string");
  if (!isNullableString(r.context_json))
    throw new Error("violations: context_json must be string or null");
  if (!isString(r.agent_id)) throw new Error("violations: agent_id must be a string");
  if (!isNullableString(r.session_id))
    throw new Error("violations: session_id must be string or null");
  return r as unknown as ViolationRow;
}

function mapRow(raw: unknown): Violation {
  const row = validateRow(raw);
  return {
    rule: row.rule,
    severity: row.severity as ViolationSeverity,
    message: row.message,
    ...(row.context_json !== null
      ? { context: JSON.parse(row.context_json) as Record<string, unknown> }
      : {}),
  };
}

function encodeCursor(id: number): string {
  return Buffer.from(String(id), "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): number | undefined {
  try {
    const s = Buffer.from(cursor, "base64url").toString("utf-8");
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export interface SqliteViolationStore extends ViolationStore {
  readonly record: (
    violation: Violation,
    agentId: AgentId,
    sessionId: string | undefined,
    timestamp: number,
  ) => void;
  readonly flush: () => void;
  readonly close: () => void;
}

export function createSqliteViolationStore(
  config: SqliteViolationStoreConfig,
): SqliteViolationStore {
  const db = new Database(config.dbPath);
  initViolationSchema(db);
  const insertStmt = createInsertStmt(db);

  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  const buffer: BufferedEntry[] = [];

  function flushBuffer(): void {
    if (buffer.length === 0) return;
    const tx = db.transaction(() => {
      for (const e of buffer) {
        insertStmt.run({
          $timestamp: e.timestamp,
          $rule: e.violation.rule,
          $severity: e.violation.severity,
          $message: e.violation.message,
          $contextJson: e.violation.context !== undefined
            ? JSON.stringify(e.violation.context)
            : null,
          $agentId: e.agentId,
          $sessionId: e.sessionId ?? null,
        });
      }
    });
    tx();
    buffer.length = 0;
  }

  const timer = setInterval(flushBuffer, flushIntervalMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  function buildQuery(filter: ViolationFilter): {
    readonly sql: string;
    readonly params: Record<string, string | number>;
    readonly limit: number;
  } {
    const limit = filter.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
    const params: Record<string, string | number> = {};
    const where: string[] = [];

    if (filter.agentId !== undefined) {
      where.push("agent_id = $agentId");
      params.$agentId = filter.agentId;
    }
    if (filter.sessionId !== undefined) {
      where.push("session_id = $sessionId");
      params.$sessionId = filter.sessionId;
    }
    if (filter.rule !== undefined) {
      where.push("rule = $rule");
      params.$rule = filter.rule;
    }
    if (filter.severity !== undefined) {
      const minIdx = VIOLATION_SEVERITY_ORDER.indexOf(filter.severity);
      const allowed = VIOLATION_SEVERITY_ORDER.slice(minIdx);
      if (allowed.length === 0) {
        where.push("0");
      } else {
        const placeholders = allowed
          .map((_, i) => {
            const key = `$sev${i}`;
            params[key] = allowed[i] as string;
            return key;
          })
          .join(",");
        where.push(`severity IN (${placeholders})`);
      }
    }
    if (filter.since !== undefined) {
      where.push("timestamp >= $since");
      params.$since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push("timestamp < $until");
      params.$until = filter.until;
    }
    if (filter.offset !== undefined) {
      const decoded = decodeCursor(filter.offset);
      if (decoded !== undefined) {
        where.push("id < $cursor");
        params.$cursor = decoded;
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM violations ${whereSql} ORDER BY id DESC LIMIT $limit`;
    params.$limit = limit + 1; // fetch one extra to decide cursor
    return { sql, params, limit };
  }

  function getViolationsSync(filter: ViolationFilter): ViolationPage {
    flushBuffer();
    const { sql, params, limit } = buildQuery(filter);
    const rows = db.prepare(sql).all(params);
    const validRows = rows.map(validateRow);
    const hasMore = validRows.length > limit;
    const pageRows = hasMore ? validRows.slice(0, limit) : validRows;
    const items = pageRows.map((r) => mapRow(r));

    const base: ViolationPage = { items };
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      if (last !== undefined) {
        return { ...base, cursor: encodeCursor(last.id) };
      }
    }
    return base;
  }

  return {
    record(
      violation: Violation,
      agentIdArg: AgentId,
      sessionId: string | undefined,
      timestamp: number,
    ): void {
      buffer.push({ violation, agentId: agentIdArg, sessionId, timestamp });
      if (buffer.length >= maxBufferSize) {
        flushBuffer();
      }
    },
    async getViolations(filter: ViolationFilter): Promise<ViolationPage> {
      return getViolationsSync(filter);
    },
    flush(): void {
      flushBuffer();
    },
    close(): void {
      clearInterval(timer);
      flushBuffer();
      db.close();
    },
  };
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```typescript
/** @koi/violation-store-sqlite — append-only SQLite ViolationStore. */
export type { SqliteViolationStoreConfig } from "./config.js";
export { validateSqliteViolationStoreConfig } from "./config.js";
export type { SqliteViolationStore } from "./sqlite-store.js";
export { createSqliteViolationStore } from "./sqlite-store.js";
```

- [ ] **Step 5: Run all package tests**

Run: `bun test --cwd packages/security/violation-store-sqlite`
Expected: PASS (all tests: config 8 + schema 4 + store 12 = 24).

- [ ] **Step 6: Typecheck + lint**

Run: `bun run --cwd packages/security/violation-store-sqlite typecheck && bun run --cwd packages/security/violation-store-sqlite lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/security/violation-store-sqlite/src/sqlite-store.ts \
        packages/security/violation-store-sqlite/src/sqlite-store.test.ts \
        packages/security/violation-store-sqlite/src/index.ts
git commit -m "feat(#1393): SQLite ViolationStore with buffered writes + indexed queries"
```

---

## Task 10: Runtime-factory — Compliance Recorder Wiring

**Files:**
- Modify: `packages/meta/cli/src/runtime-factory.ts`

- [ ] **Step 1: Add the import (top of file imports block, alongside existing governance-defaults imports)**

Find the existing line:

```typescript
import { createPatternBackend } from "@koi/governance-defaults";
```

Replace with:

```typescript
import {
  createAuditSinkComplianceRecorder,
  createPatternBackend,
  fanOutComplianceRecorder,
} from "@koi/governance-defaults";
```

- [ ] **Step 2: Collect recorders alongside audit sink creation**

Near the top of the function body where audit sinks are created (search for `const auditSink = createNdjsonAuditSink(`), declare a recorder array BEFORE the NDJSON block:

```typescript
// Compliance recorders accumulated from each active audit sink.
// Used later to populate governanceBackend.compliance.
const complianceRecorders: import("@koi/core").ComplianceRecorder[] = [];
```

- [ ] **Step 3: After NDJSON sink creation (search `const auditSink = createNdjsonAuditSink(`), push a recorder:**

Immediately after `const auditMw = createAuditMiddleware({ sink: auditSink, signing: true });`:

```typescript
complianceRecorders.push(
  createAuditSinkComplianceRecorder(auditSink, { sessionId }),
);
```

(Use the same `sessionId` variable already in scope for the NDJSON block. If it isn't, derive it from `config.sessionId ?? makeAgentId("session").sessionId` — check the surrounding code and reuse the existing session value.)

- [ ] **Step 4: After SQLite sink creation (search `const sqliteSink = createSqliteAuditSink(`), push another recorder:**

Immediately after the SQLite sink is assigned:

```typescript
complianceRecorders.push(
  createAuditSinkComplianceRecorder(sqliteSink, { sessionId }),
);
```

- [ ] **Step 5: At `governanceBackend` assembly (current line ~2251), merge `compliance`**

Locate:

```typescript
const governanceBackend = governanceEnabled
  ? config.governanceRules !== undefined && config.governanceRules.length > 0
    ? createPatternBackend({ rules: config.governanceRules, defaultDeny: false })
    : createDefaultPatternBackend()
  : undefined;
```

Replace with:

```typescript
const rawGovernanceBackend = governanceEnabled
  ? config.governanceRules !== undefined && config.governanceRules.length > 0
    ? createPatternBackend({ rules: config.governanceRules, defaultDeny: false })
    : createDefaultPatternBackend()
  : undefined;

const complianceRecorder =
  complianceRecorders.length > 0
    ? fanOutComplianceRecorder(complianceRecorders)
    : undefined;

const governanceBackend =
  rawGovernanceBackend !== undefined && complianceRecorder !== undefined
    ? { ...rawGovernanceBackend, compliance: complianceRecorder }
    : rawGovernanceBackend;
```

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd packages/meta/cli typecheck`
Expected: PASS.

- [ ] **Step 7: Run runtime-factory tests — confirm nothing regresses**

Run: `bun test --cwd packages/meta/cli runtime-factory`
Expected: PASS (no assertion about compliance yet; regression guard only).

- [ ] **Step 8: Commit**

```bash
git add packages/meta/cli/src/runtime-factory.ts
git commit -m "feat(#1393): wire ComplianceRecorder into governance backend"
```

---

## Task 11: Runtime-factory — ViolationStore Config + Wiring

**Files:**
- Modify: `packages/meta/cli/src/runtime-factory.ts`

- [ ] **Step 1: Add `violationSqlitePath` to the config interface**

Find the line `readonly auditSqlitePath?: string | undefined;` (around line 719). Add immediately after:

```typescript
/** Absolute path to the SQLite DB backing the ViolationStore. When set,
 *  policy-violation events are persisted to this DB and made queryable via
 *  `governanceBackend.violations`. Opt-in; if omitted, violations are only
 *  surfaced in-memory via the governance bridge. */
readonly violationSqlitePath?: string | undefined;
```

- [ ] **Step 2: Add the import**

At the top of the file:

```typescript
import { createSqliteViolationStore } from "@koi/violation-store-sqlite";
```

- [ ] **Step 3: Create the store near audit-sink creation, before governanceBackend assembly**

Find the section right before `const rawGovernanceBackend = governanceEnabled` (from Task 10). Insert:

```typescript
// --- Violation store (opt-in via config.violationSqlitePath) ---
const violationStore =
  config.violationSqlitePath !== undefined
    ? createSqliteViolationStore({ dbPath: config.violationSqlitePath })
    : undefined;
```

- [ ] **Step 4: Merge `violations` into governanceBackend**

Update the Task 10 block to include `violations`:

```typescript
const governanceBackend =
  rawGovernanceBackend !== undefined
    ? {
        ...rawGovernanceBackend,
        ...(complianceRecorder !== undefined ? { compliance: complianceRecorder } : {}),
        ...(violationStore !== undefined ? { violations: violationStore } : {}),
      }
    : rawGovernanceBackend;
```

- [ ] **Step 5: Register shutdown close**

Find the shutdown block (search for `auditSqliteMwForShutdown`). Add near it:

```typescript
// Close violation store on shutdown (flushes buffer).
if (violationStore !== undefined) {
  violationStore.close();
}
```

Place inside the existing shutdown handler function, following the pattern used for `sqliteAudit.close()`.

- [ ] **Step 6: Wire onViolation callback into the store**

Find where `createGovernanceMiddleware` is invoked (around line 2262). The middleware accepts an `onViolation` callback via governance-core. Locate the existing `onViolation` wiring in the middleware options block (the TUI already subscribes via governance-bridge's `recordViolation`).

If the middleware options currently look like `{ backend, controller, cost, observerOnly: true, ... }`, extend with:

```typescript
onViolation: (agentIdStr: string, violation, timestamp, sessionId) => {
  violationStore?.record(
    violation,
    makeAgentId(agentIdStr),
    sessionId,
    timestamp,
  );
},
```

Note: the exact `onViolation` signature comes from `@koi/governance-core`. Inspect `createGovernanceMiddleware` to confirm parameter order, then align. If the callback is already defined and routed to the bridge, add the store call alongside it (do not remove the bridge call).

- [ ] **Step 7: Typecheck**

Run: `bun run --cwd packages/meta/cli typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/meta/cli/src/runtime-factory.ts
git commit -m "feat(#1393): wire SQLite ViolationStore behind violationSqlitePath flag"
```

---

## Task 12: Governance-bridge — Accept ViolationStore + `loadRecentViolations`

**Files:**
- Modify: `packages/meta/cli/src/governance-bridge.ts`
- Modify: `packages/meta/cli/src/governance-bridge.test.ts`

- [ ] **Step 1: Write failing bridge test cases**

Append to `packages/meta/cli/src/governance-bridge.test.ts`:

```typescript
import type { ViolationStore } from "@koi/core";

describe("loadRecentViolations", () => {
  test("returns [] when violationStore is absent", async () => {
    // (reuse existing helper that builds a bridge without a store — adapt
    // per the file's existing test-setup helpers; pattern the call after the
    // existing `loadRecentAlerts` tests.)
    const bridge = buildBridge(/* no store */);
    const page = await bridge.loadRecentViolations(10);
    expect(page).toEqual([]);
  });

  test("queries the store with current sessionId + limit", async () => {
    let seenFilter: unknown;
    const store: ViolationStore = {
      getViolations: async (filter) => {
        seenFilter = filter;
        return { items: [{ rule: "r1", severity: "warning", message: "m" }] };
      },
    };
    const bridge = buildBridge({ violationStore: store, sessionId: "S" });
    const page = await bridge.loadRecentViolations(5);
    expect(page).toHaveLength(1);
    expect(seenFilter).toMatchObject({ sessionId: "S", limit: 5 });
  });

  test("returns [] and warns when store throws", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store: ViolationStore = {
        getViolations: async () => {
          throw new Error("db gone");
        },
      };
      const bridge = buildBridge({ violationStore: store });
      const page = await bridge.loadRecentViolations(5);
      expect(page).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
```

Replace `buildBridge(...)` shape to match whatever helper this test file already uses to create a bridge instance. Inspect the top of the test file for the current helper and extend it to accept `violationStore` as an optional field.

- [ ] **Step 2: Run to confirm failure**

Run: `bun test --cwd packages/meta/cli governance-bridge`
Expected: FAIL — `loadRecentViolations` does not exist.

- [ ] **Step 3: Extend `GovernanceBridgeConfig`**

In `packages/meta/cli/src/governance-bridge.ts`, add to the interface (around line 49, after the existing `alertThresholds`):

```typescript
/** Optional persistent store used by `loadRecentViolations`. Absence =>
 *  `loadRecentViolations` returns []. */
readonly violationStore?: ViolationStore | undefined;
```

Add import:

```typescript
import type { Violation, ViolationStore } from "@koi/core";
```

- [ ] **Step 4: Extend the `GovernanceBridge` interface**

Add after `loadRecentAlerts`:

```typescript
/** Load up to N most recent persisted violations for the current session.
 *  Returns [] when no ViolationStore is configured. Errors are swallowed
 *  (logged via console.warn) so a transient DB issue cannot block the
 *  governance view. */
readonly loadRecentViolations: (n: number) => Promise<readonly Violation[]>;
```

- [ ] **Step 5: Implement the method**

Inside `createGovernanceBridge`, add the function and include it in the returned object:

```typescript
async function loadRecentViolations(n: number): Promise<readonly Violation[]> {
  if (config.violationStore === undefined) return [];
  try {
    const page = await config.violationStore.getViolations({
      sessionId,
      limit: n,
    });
    return page.items;
  } catch (err) {
    console.warn("[governance-bridge] loadRecentViolations failed:", err);
    return [];
  }
}
```

Then include `loadRecentViolations,` in the returned object alongside `loadRecentAlerts`.

- [ ] **Step 6: Run tests**

Run: `bun test --cwd packages/meta/cli governance-bridge`
Expected: PASS.

- [ ] **Step 7: Thread `violationStore` through in `runtime-factory.ts`**

Find the `createGovernanceBridge({ ... })` call in `runtime-factory.ts`. Add:

```typescript
...(violationStore !== undefined ? { violationStore } : {}),
```

- [ ] **Step 8: Typecheck**

Run: `bun run --cwd packages/meta/cli typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/meta/cli/src/governance-bridge.ts \
        packages/meta/cli/src/governance-bridge.test.ts \
        packages/meta/cli/src/runtime-factory.ts
git commit -m "feat(#1393): governance-bridge.loadRecentViolations (SQLite-backed)"
```

---

## Task 13: Integration Test — runtime-factory End-to-End

**Files:**
- Modify: `packages/meta/cli/src/runtime-factory.test.ts`

- [ ] **Step 1: Write the integration test**

Append a new `describe` block to `packages/meta/cli/src/runtime-factory.test.ts`. Adapt the helper pattern already used in that file — do not invent a new harness:

```typescript
describe("runtime-factory — governance audit wiring (#1393)", () => {
  test("auditSqlitePath enables compliance recording via backend.compliance", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createSqliteAuditSink } = await import("@koi/audit-sink-sqlite");
    const dir = mkdtempSync(join(tmpdir(), "rf-"));
    const auditPath = join(dir, "audit.db");
    const violationsPath = join(dir, "v.db");
    try {
      const { runtime, shutdown } = await buildRuntimeWith({
        auditSqlitePath: auditPath,
        violationSqlitePath: violationsPath,
        governanceEnabled: true,
      });
      expect(runtime.governanceBackend?.compliance).toBeDefined();
      expect(runtime.governanceBackend?.violations).toBeDefined();
      await shutdown();

      // Re-open audit DB and assert at least one compliance_event row could
      // exist after a denied verdict. This step is scoped to assert the
      // schema + wiring, not to synthesize a verdict — that is exercised in
      // the golden-replay test (Task 14).
      const sink = createSqliteAuditSink({ dbPath: auditPath });
      expect(sink.getEntries).toBeDefined();
      sink.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

`buildRuntimeWith(...)` stands in for whatever factory helper the existing test file uses. If none exists, inline `createKoiRuntime(...)` with the minimum viable config — look at adjacent tests in the same file to copy the pattern.

- [ ] **Step 2: Run**

Run: `bun test --cwd packages/meta/cli runtime-factory`
Expected: PASS (new block + all pre-existing cases).

- [ ] **Step 3: Commit**

```bash
git add packages/meta/cli/src/runtime-factory.test.ts
git commit -m "test(#1393): integration test — compliance + violation wiring"
```

---

## Task 14: `@koi/runtime` Dependency + Golden Replay Assertion

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Add dep to `packages/meta/runtime/package.json`**

Add alphabetically in `dependencies`:

```json
    "@koi/violation-store-sqlite": "workspace:*",
```

- [ ] **Step 2: Add project reference to `packages/meta/runtime/tsconfig.json`**

Add in `references`:

```json
{ "path": "../../security/violation-store-sqlite" },
```

- [ ] **Step 3: Run `bun install` to refresh workspace linkage**

Run: `bun install`
Expected: `bun.lock` updated; no errors.

- [ ] **Step 4: Add golden-replay assertion for permission-deny query**

Locate the `permission-deny` test block in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`. Extend it (do not rewrite) with a ViolationStore assertion. Pattern:

```typescript
test("permission-deny: denied tool produces a violation in the SQLite store", async () => {
  const { tmpdir } = await import("node:os");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createSqliteViolationStore } = await import("@koi/violation-store-sqlite");
  const dir = mkdtempSync(join(tmpdir(), "gq-"));
  const dbPath = join(dir, "v.db");
  try {
    // (Invoke the existing permission-deny replay harness with
    // violationSqlitePath = dbPath. Exact harness-call signature follows the
    // other replay tests in this file — adapt to match.)
    await runPermissionDenyReplayWithStore(dbPath);

    const store = createSqliteViolationStore({ dbPath });
    const page = await store.getViolations({ limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Replace `runPermissionDenyReplayWithStore` with a call mirroring whatever replay driver the file uses. Inspect the existing `permission-deny` test case to copy its `buildRuntime` + replay wiring; only addition is threading `violationSqlitePath` through.

- [ ] **Step 5: Run replay tests**

Run: `bun test --cwd packages/meta/runtime golden-replay`
Expected: PASS (existing cassettes unchanged + new assertion passes).

- [ ] **Step 6: Run orphan + golden-queries checks**

Run:

```bash
bun run check:orphans
bun run check:golden-queries
```

Expected: PASS on both.

- [ ] **Step 7: Commit**

```bash
git add packages/meta/runtime/package.json \
        packages/meta/runtime/tsconfig.json \
        packages/meta/runtime/src/__tests__/golden-replay.test.ts \
        bun.lock
git commit -m "feat(#1393): wire @koi/violation-store-sqlite into @koi/runtime + golden"
```

---

## Task 15: Secondary Docs — Sinks + Architecture

**Files:**
- Modify: `docs/L2/audit-sink-ndjson.md`
- Modify: `docs/L2/audit-sink-sqlite.md`
- Modify: `docs/architecture/governance-backend.md`

- [ ] **Step 1: Update `docs/L2/audit-sink-ndjson.md`**

Append a note after the existing "Usage" section:

```markdown
## Compliance events

When this sink is wired via `--audit-ndjson`, `runtime-factory.ts` also wraps
it in `createAuditSinkComplianceRecorder` from `@koi/governance-defaults`.
Every governance verdict produces one extra NDJSON line with
`kind: "compliance_event"` — no separate flag required.
```

- [ ] **Step 2: Update `docs/L2/audit-sink-sqlite.md`**

Append the same note adapted for SQLite:

```markdown
## Compliance events

When this sink is wired via `--audit-sqlite`, `runtime-factory.ts` also wraps
it in `createAuditSinkComplianceRecorder` from `@koi/governance-defaults`.
Every governance verdict produces an additional row with
`kind = 'compliance_event'`, discoverable via the existing time+kind index.
```

- [ ] **Step 3: Update `docs/architecture/governance-backend.md`**

Add a wiring diagram section:

````markdown
## Wiring (current)

```
                     ┌────────────────────────┐
 audit-ndjson / ──►  │ AuditSink              │
 audit-sqlite        └──────────┬─────────────┘
                                │ sink.log()
                                ▼
                  ┌──────────────────────────┐
                  │ AuditSinkComplianceRecorder│  ◄── ctx.sessionId
                  └──────────┬───────────────┘
                             │ recordCompliance()
                             ▼
                  GovernanceBackend.compliance

 ─────────────────────────────────────────────

 deny verdict ─► onViolation callback ─► SqliteViolationStore.record()
                                         ▲
                                         │ getViolations({ sessionId, limit })
                                         │
 /governance ◄── bridge.loadRecentViolations(n)
```

Both pipes are optional. `compliance` is auto-wired from the active audit
sink(s) (fan-out when more than one). `violations` is opt-in via
`--violation-sqlite=<path>`.
````

- [ ] **Step 4: Commit docs**

```bash
git add docs/L2/audit-sink-ndjson.md \
        docs/L2/audit-sink-sqlite.md \
        docs/architecture/governance-backend.md
git commit -m "docs(#1393): update audit-sink + governance-backend docs for compliance_event"
```

---

## Task 16: Full CI Gate + PR

- [ ] **Step 1: Run the full CI gate**

```bash
bun run typecheck
bun run lint
bun run test
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run check:orphans
bun run check:golden-queries
```

Expected: All PASS.

- [ ] **Step 2: Inspect final diff size**

Run: `git diff --stat main...HEAD | tail -1`
Expected: < 1500 logic-line delta (excluding snapshot regenerations and docs).

- [ ] **Step 3: Push branch + open PR**

```bash
git push -u origin worktree-cosmic-fluttering-clover
gh pr create --title "feat(#1393): governance audit wiring — ComplianceRecorder + SQLite ViolationStore" --body "$(cat <<'EOF'
## Summary
- Adds `compliance_event` to `AuditEntry.kind` (L0).
- New `createAuditSinkComplianceRecorder` + `fanOutComplianceRecorder` in `@koi/governance-defaults` (audit-sink-agnostic).
- New L2 package `@koi/violation-store-sqlite` — append-only, WAL, indexed queries.
- `runtime-factory.ts` auto-wraps active audit sinks as `governanceBackend.compliance`; new `--violation-sqlite` flag enables `governanceBackend.violations`.
- `governance-bridge.loadRecentViolations(n)` for `/governance` history backfill.

Closes gov-9 follow-up items 1 and 2 (onUsage deferred per #1938 review).

## Test plan
- [ ] New unit tests: `compliance-recorder.test.ts`, `sqlite-store.test.ts`, `schema.test.ts`, `config.test.ts`
- [ ] Bridge tests: `governance-bridge.test.ts` new `loadRecentViolations` cases
- [ ] Integration: `runtime-factory.test.ts` new `#1393` describe
- [ ] Golden replay: `permission-deny` asserts violation row in SQLite store
- [ ] CI: typecheck, lint, layers, unused, duplicates, orphans, golden-queries all green
EOF
)"
```

- [ ] **Step 4: Record PR URL in the issue**

```bash
PR_URL=$(gh pr view --json url --jq .url)
gh issue comment 1393 -R windoliver/koi -b "PR: ${PR_URL}"
```

---

## Spec coverage self-check

| Spec requirement | Covered by task |
|------------------|-----------------|
| L0 `compliance_event` kind | Task 1 |
| ComplianceRecorder factory + mapping | Tasks 4, 5 |
| `fanOutComplianceRecorder` | Task 5 |
| ComplianceRecorder on-error contract | Task 4 (tests), Task 5 (impl) |
| New `@koi/violation-store-sqlite` package | Tasks 6–9 |
| Append-only guarantee test | Task 8 |
| Config validator | Task 7 |
| SQLite schema + indexes | Task 8 |
| WAL mode | Task 8 (PRAGMA), Task 9 (concurrency test) |
| Buffered writes + flush + close | Task 9 |
| Filter dimensions (agent, session, severity, rule, since/until, limit, offset cursor) | Task 9 |
| Row validation | Task 9 |
| Runtime-factory compliance wiring (auto from audit sinks) | Task 10 |
| Runtime-factory `violationSqlitePath` flag | Task 11 |
| `onViolation` → store.record() | Task 11 |
| Shutdown close for violation store | Task 11 |
| Bridge `violationStore` config + `loadRecentViolations` | Task 12 |
| Integration test | Task 13 |
| `@koi/runtime` dep + golden query assertion | Task 14 |
| Docs: governance-defaults | Task 2 |
| Docs: violation-store-sqlite L2 doc | Task 3 |
| Docs: audit-sink-{ndjson,sqlite} | Task 15 |
| Docs: architecture governance-backend | Task 15 |
| CI gate (all checks) | Task 16 |
| PR creation + issue link | Task 16 |
