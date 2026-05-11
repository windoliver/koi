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

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (` +
      `execution_id TEXT PRIMARY KEY, ` +
      `plan_hash TEXT NOT NULL, ` +
      `next_step_index INTEGER NOT NULL, ` +
      `step_results TEXT NOT NULL, ` +
      `phase TEXT NOT NULL CHECK (phase IN ('in_progress', 'completed', 'failed')), ` +
      `saved_at INTEGER NOT NULL` +
      `)`,
  );

  const upsert: SqliteStatementLike = db.prepare(
    `INSERT INTO ${table} (execution_id, plan_hash, next_step_index, step_results, phase, saved_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(execution_id) DO UPDATE SET ` +
      `plan_hash = excluded.plan_hash, ` +
      `next_step_index = excluded.next_step_index, ` +
      `step_results = excluded.step_results, ` +
      `phase = excluded.phase, ` +
      `saved_at = excluded.saved_at`,
  );
  const selectByKey: SqliteStatementLike = db.prepare(
    `SELECT plan_hash, next_step_index, step_results, phase, saved_at ` +
      `FROM ${table} WHERE execution_id = ?`,
  );
  const deleteByKey: SqliteStatementLike = db.prepare(
    `DELETE FROM ${table} WHERE execution_id = ?`,
  );

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
      upsert.run(
        snapshot.executionId,
        snapshot.planHash,
        String(snapshot.nextStepIndex),
        json,
        snapshot.phase,
        String(snapshot.savedAt),
      );
    },
    load: (id) => {
      // bun:sqlite returns `null` for missing rows; node:sqlite returns
      // `undefined`. Coerce both to undefined to keep the load surface
      // aligned with the L0 contract (`T | undefined`).
      const raw = selectByKey.get(id);
      if (raw === undefined || raw === null) return undefined;
      const row = raw as {
        readonly plan_hash: string;
        readonly next_step_index: number;
        readonly step_results: string;
        readonly phase: string;
        readonly saved_at: number;
      };
      if (!VALID_PHASES.has(row.phase as CheckpointPhase)) {
        // A row with an unrecognized phase indicates corruption (CHECK
        // constraint should prevent insertion, but external writers could
        // bypass it). Surface as undefined so the caller starts fresh
        // rather than acting on garbage.
        return undefined;
      }
      const stepResults = JSON.parse(row.step_results) as readonly CheckpointValue[];
      return {
        executionId: id,
        planHash: row.plan_hash,
        nextStepIndex: row.next_step_index,
        stepResults,
        phase: row.phase as CheckpointPhase,
        savedAt: row.saved_at,
      };
    },
    delete: (id) => {
      deleteByKey.run(id);
    },
  };
}
