import {
  type CheckpointEncoder,
  type CheckpointPhase,
  type CheckpointSnapshot,
  type CheckpointValue,
  type CompositionCheckpointStore,
  safeJsonEncoder,
} from "./composition-checkpoint-store.js";
import type {
  SqliteDatabaseLike,
  SqliteStatementLike,
} from "./composition-execution-log-sqlite.js";

export type { SqliteDatabaseLike, SqliteStatementLike };

/**
 * Local extension of `SqliteStatementLike` adding `.all(...)` — required by
 * the checkpoint store's `list()` enumeration but NOT widened onto the
 * shared `SqliteStatementLike` contract so existing `sqliteCompositionExecutionLog`
 * consumers that implemented only `run` and `get` continue to type-check.
 * Both `bun:sqlite` and `node:sqlite` provide `.all(...)` natively, so the
 * runtime check in `sqliteCompositionCheckpointStore` will pass for both
 * canonical drivers; custom shims that omit it will fail explicitly at
 * construction.
 */
interface SqliteStatementLikeAll extends SqliteStatementLike {
  readonly all: (...params: (string | null)[]) => readonly unknown[];
}

/**
 * Diagnostics for a row that could not be decoded into a `CheckpointSnapshot`
 * (corrupt JSON, schema drift, manual repair mistake, or missing field).
 * Surfaced through `SqliteCheckpointStoreConfig.onCorruptRow` so a host
 * sweeping `list()` for restart recovery does not silently lose track of
 * an execution that needs operator attention.
 */
export interface CheckpointStoreCorruptRow {
  /** Best-effort executionId from the row; `undefined` if even that column is unrecoverable. */
  readonly executionId: string | undefined;
  /** Short reason describing what failed to decode. */
  readonly reason: string;
}

export interface SqliteCheckpointStoreConfig {
  readonly tableName?: string;
  /**
   * Encoder applied to each `stepResults[i]` BEFORE JSON serialization to
   * the row. Matches the in-memory store's contract so callers can pass
   * arbitrary `unknown` step outputs (Date, class instance, etc.) and have
   * the configured codec sanitize them. Defaults to `safeJsonEncoder`. Set
   * to `null` to opt out and require pre-encoded `CheckpointValue` inputs.
   */
  readonly encoder?: CheckpointEncoder | null;
  /**
   * Diagnostics callback invoked when `load(id)` or `list()` encounters a
   * row it cannot decode (corrupt JSON, drift, missing field). The callback
   * MUST NOT throw — failures inside the callback are swallowed so a
   * faulty diagnostics handler cannot break recovery. Hosts that wire this
   * can log, page operators, or store a side-channel reconciliation queue
   * so executions whose checkpoints decode-failed never become invisible.
   * When omitted, corrupt rows are silently dropped (legacy behavior).
   */
  readonly onCorruptRow?: (record: CheckpointStoreCorruptRow) => void;
}

const VALID_PHASES = new Set<CheckpointPhase>(["in_progress", "completed", "failed"]);

/**
 * Durable, restart-safe `CompositionCheckpointStore` backed by SQLite.
 *
 * Schema:
 *   composition_checkpoint(
 *     execution_id   TEXT PRIMARY KEY,
 *     plan_hash      TEXT    NOT NULL,
 *     next_step_index INTEGER NOT NULL,
 *     step_results   TEXT    NOT NULL,   -- JSON array of CheckpointValue
 *     phase          TEXT    NOT NULL,   -- 'in_progress' | 'completed' | 'failed'
 *     saved_at       INTEGER NOT NULL
 *   )
 *
 * - `save(snapshot)` UPSERTs by `execution_id`. Step outputs pass through
 *   the configured encoder (default: `safeJsonEncoder`) before serialization
 *   so executors can hand in raw `unknown` outputs.
 * - `load(execution_id)` returns the decoded snapshot or `undefined`.
 * - `delete(execution_id)` removes the row.
 *
 * Same `SqliteDatabaseLike` contract as `sqliteCompositionExecutionLog` —
 * works with Bun's `bun:sqlite` and Node's `node:sqlite` (Node ≥22).
 */
export function sqliteCompositionCheckpointStore(
  db: SqliteDatabaseLike,
  config: SqliteCheckpointStoreConfig = {},
): CompositionCheckpointStore {
  const table = config.tableName ?? "composition_checkpoint";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) {
    throw new Error(`sqliteCompositionCheckpointStore: invalid tableName "${table}"`);
  }
  const encoder = config.encoder === undefined ? safeJsonEncoder : config.encoder;
  const onCorruptRow = config.onCorruptRow;

  function reportCorrupt(executionId: string | undefined, reason: string): void {
    if (onCorruptRow === undefined) return;
    try {
      onCorruptRow({ executionId, reason });
    } catch {
      // A faulty diagnostics callback must not break recovery.
    }
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (` +
      `execution_id TEXT PRIMARY KEY, ` +
      `plan_hash TEXT NOT NULL, ` +
      `next_step_index INTEGER NOT NULL, ` +
      `step_results TEXT NOT NULL, ` +
      `phase TEXT NOT NULL CHECK (phase IN ('in_progress', 'completed', 'failed')), ` +
      `saved_at INTEGER NOT NULL, ` +
      // Monotonic watermark per executionId. Used to reject stale writes
      // that arrive after a newer save or delete. NULL allowed for
      // backward compatibility when callers omit `seq`. Nullable column
      // also retained as a tombstone row after delete (see delete handler).
      `seq INTEGER, ` +
      `tombstone INTEGER NOT NULL DEFAULT 0` +
      `)`,
  );
  // Schema-additive ALTER for existing databases that pre-date the seq /
  // tombstone columns. SQLite ALTER TABLE ADD COLUMN is idempotent only
  // when the column doesn't already exist, so wrap in try/catch.
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN seq INTEGER`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already exists */
  }

  // UPSERT with monotonic seq guard via `WHERE excluded.seq > ${table}.seq`.
  // - First write: INSERT path applies (no prior row).
  // - Newer write (excluded.seq > stored.seq): UPDATE applies.
  // - Stale write (excluded.seq <= stored.seq): WHERE clause filters; row unchanged.
  // - Either side NULL (legacy callers without seq): WHERE comparison
  //   yields NULL → UPDATE skipped. Falls back to the always-update form
  //   prepared below for backward-compatible last-writer-wins behavior.
  const upsertGuarded: SqliteStatementLike = db.prepare(
    `INSERT INTO ${table} (execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, 0) ` +
      `ON CONFLICT(execution_id) DO UPDATE SET ` +
      `plan_hash = excluded.plan_hash, ` +
      `next_step_index = excluded.next_step_index, ` +
      `step_results = excluded.step_results, ` +
      `phase = excluded.phase, ` +
      `saved_at = excluded.saved_at, ` +
      `seq = excluded.seq, ` +
      `tombstone = 0 ` +
      `WHERE excluded.seq > ${table}.seq`,
  );
  const upsertUnguarded: SqliteStatementLike = db.prepare(
    `INSERT INTO ${table} (execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone) ` +
      `VALUES (?, ?, ?, ?, ?, ?, NULL, 0) ` +
      `ON CONFLICT(execution_id) DO UPDATE SET ` +
      `plan_hash = excluded.plan_hash, ` +
      `next_step_index = excluded.next_step_index, ` +
      `step_results = excluded.step_results, ` +
      `phase = excluded.phase, ` +
      `saved_at = excluded.saved_at, ` +
      `tombstone = 0`,
  );
  const selectByKey: SqliteStatementLike = db.prepare(
    `SELECT plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone ` +
      `FROM ${table} WHERE execution_id = ?`,
  );
  // Delete leaves a tombstone row with the supplied seq watermark so a
  // late save() with an older seq cannot resurrect the execution. The
  // tombstone row is invisible to load() and list() (filtered).
  //
  // Crucially this is an UPSERT, not an UPDATE: a plain UPDATE is a
  // no-op when no row exists yet, leaving the door open for a delayed
  // save to insert fresh state after terminal success. UPSERT inserts
  // a tombstone row even when the executor has never written one,
  // guaranteeing the seq watermark is present BEFORE any late save can
  // attempt its INSERT-or-UPDATE.
  const deleteTombstoneVersioned: SqliteStatementLike = db.prepare(
    `INSERT INTO ${table} (execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone) ` +
      `VALUES (?, '', 0, '[]', 'completed', 0, ?, 1) ` +
      `ON CONFLICT(execution_id) DO UPDATE SET tombstone = 1, seq = MAX(seq, excluded.seq)`,
  );
  // Legacy unversioned delete for callers that pass no seq. Plain
  // tombstone UPDATE: matches existing rows only. Late saves remain
  // possible but the caller opted out of the seq guard.
  const deleteTombstoneLegacy: SqliteStatementLike = db.prepare(
    `UPDATE ${table} SET tombstone = 1 WHERE execution_id = ?`,
  );
  const selectAllStmt = db.prepare(
    `SELECT execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone ` +
      `FROM ${table}`,
  );
  // Feature-detect `.all(...)` — both bun:sqlite and node:sqlite provide it,
  // but the shared `SqliteStatementLike` contract does not require it (and we
  // intentionally do not widen that contract to keep existing execution-log
  // shims compatible). A custom shim that omits it will fail explicitly here
  // rather than at the first call to `list()`.
  if (typeof (selectAllStmt as Partial<SqliteStatementLikeAll>).all !== "function") {
    throw new Error(
      "sqliteCompositionCheckpointStore: provided SqliteDatabaseLike returned " +
        "a Statement without an `all(...)` method — required for list() " +
        "enumeration. Both bun:sqlite and node:sqlite supply this natively.",
    );
  }
  const selectAll = selectAllStmt as SqliteStatementLikeAll;

  function encodeStepResults(stepResults: readonly unknown[]): readonly CheckpointValue[] {
    if (encoder === null) return stepResults as readonly CheckpointValue[];
    const out: CheckpointValue[] = [];
    for (let i = 0; i < stepResults.length; i += 1) {
      const result = encoder.encode(stepResults[i]);
      if (!result.ok) {
        throw new Error(`stepResults[${i}] could not be encoded: ${result.error}`);
      }
      out.push(result.value);
    }
    return out;
  }

  function validate(snapshot: CheckpointSnapshot): void {
    if (snapshot.executionId === "") {
      throw new Error("executionId must be non-empty");
    }
    if (snapshot.planHash === "") {
      throw new Error("planHash must be non-empty");
    }
    if (snapshot.nextStepIndex < 0 || !Number.isInteger(snapshot.nextStepIndex)) {
      throw new Error("nextStepIndex must be >= 0 and an integer");
    }
    if (snapshot.stepResults.length !== snapshot.nextStepIndex) {
      throw new Error(
        `stepResults.length must equal nextStepIndex (got ${snapshot.stepResults.length} vs ${snapshot.nextStepIndex})`,
      );
    }
  }

  return {
    save: (snapshot) => {
      validate(snapshot);
      if (snapshot.seq !== undefined) {
        if (!Number.isInteger(snapshot.seq) || snapshot.seq < 0) {
          throw new Error(`seq must be a non-negative integer (got ${String(snapshot.seq)})`);
        }
      }
      const encoded = encodeStepResults(snapshot.stepResults);
      // JSON-serialize the encoded array. Encoder already proved every
      // element is CheckpointValue (or caller opted out and accepted the
      // risk via encoder: null), so JSON.stringify never throws here.
      const json = JSON.stringify(encoded);
      // bun:sqlite binds numbers to INTEGER/REAL columns directly, but the
      // shared SqliteStatementLike contract only declares string|null
      // parameters. Coerce numerics to string for portability; the column
      // affinity (INTEGER) converts back on read. SQLite's loose typing
      // accepts this without precision loss for our integer values.
      if (snapshot.seq !== undefined) {
        upsertGuarded.run(
          snapshot.executionId,
          snapshot.planHash,
          String(snapshot.nextStepIndex),
          json,
          snapshot.phase,
          String(snapshot.savedAt),
          String(snapshot.seq),
        );
      } else {
        upsertUnguarded.run(
          snapshot.executionId,
          snapshot.planHash,
          String(snapshot.nextStepIndex),
          json,
          snapshot.phase,
          String(snapshot.savedAt),
        );
      }
    },
    load: (id) => {
      // bun:sqlite returns `null` for missing rows; node:sqlite returns
      // `undefined`. Coerce both to undefined to keep the load surface
      // aligned with the L0 contract (`T | undefined`).
      const raw = selectByKey.get(id);
      if (raw === undefined || raw === null) return undefined;
      const outcome = decodeRow(id, raw);
      if (outcome.kind === "tombstone") return undefined;
      if (outcome.kind === "corrupt") {
        reportCorrupt(id, "row failed to decode (load)");
        return undefined;
      }
      return outcome.snapshot;
    },
    delete: (id, seq) => {
      // Versioned tombstone UPSERT when caller supplies seq — the
      // watermark is persisted even when no row exists yet, so a
      // delayed save that finishes after this delete cannot succeed
      // (its INSERT will conflict with the tombstone; its UPDATE will
      // be blocked by the seq guard).
      if (seq !== undefined) {
        if (!Number.isInteger(seq) || seq < 0) {
          throw new Error(`delete: seq must be a non-negative integer (got ${String(seq)})`);
        }
        deleteTombstoneVersioned.run(id, String(seq));
      } else {
        deleteTombstoneLegacy.run(id);
      }
    },
    list: () => {
      const rows = selectAll.all();
      const out: CheckpointSnapshot[] = [];
      for (const raw of rows) {
        if (raw === null || typeof raw !== "object") {
          reportCorrupt(undefined, "row is not an object (list)");
          continue;
        }
        const executionIdField = (raw as { readonly execution_id?: unknown }).execution_id;
        if (typeof executionIdField !== "string" || executionIdField === "") {
          reportCorrupt(undefined, "row missing or empty execution_id (list)");
          continue;
        }
        const outcome = decodeRow(executionIdField, raw);
        if (outcome.kind === "tombstone") continue;
        if (outcome.kind === "corrupt") {
          reportCorrupt(executionIdField, "row failed to decode (list)");
          continue;
        }
        out.push(outcome.snapshot);
      }
      return out;
    },
  };
}

// Defensive row decode. The persisted SQLite row sits on the restart
// boundary, so any corruption / schema drift / manual repair mistake
// must not throw out of `load()` — that would block recovery exactly
// when the store is supposed to help. Returns `undefined` on any
// malformed input so the caller starts fresh rather than acting on
// garbage. Validates the same invariants the in-memory store enforces
// on save: matching length/index, non-empty ids, integer index.
type DecodeOutcome =
  | { readonly kind: "ok"; readonly snapshot: CheckpointSnapshot }
  | { readonly kind: "tombstone" }
  | { readonly kind: "corrupt" };

function decodeRow(executionId: string, raw: unknown): DecodeOutcome {
  if (raw === null || typeof raw !== "object") return { kind: "corrupt" };
  const row = raw as {
    readonly plan_hash?: unknown;
    readonly next_step_index?: unknown;
    readonly step_results?: unknown;
    readonly phase?: unknown;
    readonly saved_at?: unknown;
    readonly seq?: unknown;
    readonly tombstone?: unknown;
  };
  // Tombstones (post-delete rows that retain the seq watermark) are
  // intentionally NOT visible to load/list — only used to reject stale
  // saves at the SQL level. A late save with a strictly-newer seq lifts
  // the tombstone via UPSERT.
  if (row.tombstone === 1 || row.tombstone === true) {
    return { kind: "tombstone" };
  }
  const planHash = row.plan_hash;
  const nextStepIndexField = row.next_step_index;
  const stepResultsJson = row.step_results;
  const phaseField = row.phase;
  const savedAtField = row.saved_at;
  if (typeof planHash !== "string" || planHash === "") return { kind: "corrupt" };
  if (typeof nextStepIndexField !== "number" || !Number.isInteger(nextStepIndexField)) {
    return { kind: "corrupt" };
  }
  if (nextStepIndexField < 0) return { kind: "corrupt" };
  if (typeof phaseField !== "string") return { kind: "corrupt" };
  if (!VALID_PHASES.has(phaseField as CheckpointPhase)) return { kind: "corrupt" };
  if (typeof savedAtField !== "number" || !Number.isFinite(savedAtField)) {
    return { kind: "corrupt" };
  }
  if (typeof stepResultsJson !== "string") return { kind: "corrupt" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stepResultsJson);
  } catch {
    return { kind: "corrupt" };
  }
  if (!Array.isArray(parsed)) return { kind: "corrupt" };
  if (parsed.length !== nextStepIndexField) return { kind: "corrupt" };
  const seqField = row.seq;
  const seq = typeof seqField === "number" && Number.isInteger(seqField) ? seqField : undefined;
  return {
    kind: "ok",
    snapshot: {
      executionId,
      planHash,
      nextStepIndex: nextStepIndexField,
      stepResults: parsed as readonly CheckpointValue[],
      phase: phaseField as CheckpointPhase,
      savedAt: savedAtField,
      ...(seq === undefined ? {} : { seq }),
    },
  };
}
