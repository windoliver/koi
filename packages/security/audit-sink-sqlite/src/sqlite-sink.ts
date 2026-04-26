/**
 * SQLite-backed audit sink with batched inserts, WAL mode, and safe row mapping.
 *
 * Buffers entries in memory and flushes in transactions. WAL mode enables
 * concurrent readers during writes. No `as` casts — all DB rows are validated.
 */

import { Database } from "bun:sqlite";
import type { AuditEntry, AuditSink } from "@koi/core";
import type { SqliteAuditSinkConfig } from "./config.js";
import { type AuditLogRow, createInsertStmt, initAuditSchema, readAllRows } from "./schema.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BUFFER_SIZE = 100;
const DEFAULT_PRUNE_INTERVAL_MS = 3600_000; // 1 hour

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/** Validate a raw DB row and throw a descriptive error if any field is malformed. */
function validateRow(row: unknown): AuditLogRow {
  if (row === null || row === undefined || typeof row !== "object") {
    throw new Error("audit_log: row must be a non-null object");
  }
  const r = row as Record<string, unknown>;

  if (!isNumber(r.id)) throw new Error("audit_log: id must be a number");
  if (!isNumber(r.schema_version)) throw new Error("audit_log: schema_version must be a number");
  if (!isNumber(r.timestamp)) throw new Error("audit_log: timestamp must be a number");
  if (!isString(r.session_id)) throw new Error("audit_log: session_id must be a string");
  if (!isString(r.agent_id)) throw new Error("audit_log: agent_id must be a string");
  if (!isNumber(r.turn_index)) throw new Error("audit_log: turn_index must be a number");
  if (!isString(r.kind)) throw new Error("audit_log: kind must be a string");
  if (!isNullableString(r.request)) throw new Error("audit_log: request must be string or null");
  if (!isNullableString(r.response)) throw new Error("audit_log: response must be string or null");
  if (!isNullableString(r.error)) throw new Error("audit_log: error must be string or null");
  if (!isNumber(r.duration_ms)) throw new Error("audit_log: duration_ms must be a number");
  if (!isNullableString(r.prev_hash))
    throw new Error("audit_log: prev_hash must be string or null");
  if (!isNullableString(r.signature))
    throw new Error("audit_log: signature must be string or null");
  if (!isNullableString(r.metadata)) throw new Error("audit_log: metadata must be string or null");
  if (!isNullableString(r.canonical_json))
    throw new Error("audit_log: canonical_json must be string or null");

  return r as unknown as AuditLogRow;
}

function parseNullableJson(value: string | null): unknown {
  if (value === null) return undefined;
  return JSON.parse(value) as unknown;
}

function mapRow(raw: unknown): AuditEntry {
  const row = validateRow(raw);
  // When canonical_json is present, use it directly: it preserves the exact property
  // order used when the entry was signed/hash-chained, so verification round-trips correctly.
  if (row.canonical_json !== null) {
    return JSON.parse(row.canonical_json) as AuditEntry;
  }
  // Fallback for rows written before canonical_json was added (schema migration path).
  return {
    schema_version: row.schema_version,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    agentId: row.agent_id,
    turnIndex: row.turn_index,
    kind: row.kind as AuditEntry["kind"],
    durationMs: row.duration_ms,
    ...(row.request !== null ? { request: parseNullableJson(row.request) } : {}),
    ...(row.response !== null ? { response: parseNullableJson(row.response) } : {}),
    ...(row.error !== null ? { error: parseNullableJson(row.error) } : {}),
    ...(row.prev_hash !== null ? { prev_hash: row.prev_hash } : {}),
    ...(row.signature !== null ? { signature: row.signature } : {}),
    ...(row.metadata !== null
      ? { metadata: parseNullableJson(row.metadata) as Record<string, unknown> }
      : {}),
  };
}

export function createSqliteAuditSink(config: SqliteAuditSinkConfig): AuditSink & {
  /** Flush pending buffer to SQLite. Always present on this implementation. */
  readonly flush: () => Promise<void>;
  /** Flush buffer and close the database. */
  readonly close: () => void;
  /** Read all stored entries (for testing). */
  readonly getEntries: () => readonly AuditEntry[];
} {
  const db = new Database(config.dbPath);
  initAuditSchema(db);

  const insertStmt = createInsertStmt(db);
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  // Mutable buffer — never exposed
  const buffer: AuditEntry[] = [];

  function pruneOldEntries(): void {
    if (!config.retention) return;
    // Flush first so no buffered expired row survives pruning or re-inserts after DELETE.
    flushBuffer();
    try {
      const cutoff = Date.now() - config.retention.maxAgeDays * 86_400_000;

      // Prune sessions that are both fully expired AND explicitly closed.
      //
      // A session is prunable only when:
      //   1. ALL entries have timestamps older than the cutoff (fully expired), AND
      //   2. The session contains a 'session_end' entry (explicitly closed).
      //
      // Requiring session_end prevents two failure modes:
      //   - Long-lived or reused session IDs: a session that's been active for months
      //     would have MAX(timestamp) >= cutoff even though old entries are expired.
      //     Without this guard, operators enabling retention on long-lived sessions
      //     would see no pruning and assume the feature is broken.
      //   - Incomplete sessions (crashed before session_end): without a close marker,
      //     we cannot know whether more entries will be written. Pruning an open session
      //     that resumes later would leave dangling prev_hash references.
      //
      // Trade-off: sessions that crash before session_end are never pruned.
      // Operators who need guaranteed cleanup for crashed sessions can restart
      // the agent (which writes session_end) before enabling retention.
      // Group by (agent_id, session_id) rather than session_id alone: session IDs
      // are host-supplied and may be reused across agents or tenants sharing the same
      // audit DB. Scoping to the agent+session pair prevents cross-agent prune collisions
      // where one agent's expired session could match — and delete — another agent's rows.
      //
      // When config.agentId is set, further restrict the subquery to that agent so one
      // sink instance cannot prune sessions belonging to other agents in a shared DB.
      // Step 1: Find candidate sessions (expired + session_end).
      // Step 2: Filter out sessions that are part of an active hash chain —
      //   if any row with id > max(session's ids) has prev_hash IS NOT NULL,
      //   this session is mid-chain and pruning it would make the remaining chain
      //   unverifiable (surviving rows would have prev_hash pointing at deleted rows).
      //   SQLite does not allow outer aggregate references inside correlated HAVING
      //   subqueries, so we do the chain-safety check in two SQL steps.
      const candidateStmt =
        config.agentId !== undefined
          ? db.prepare(
              `SELECT agent_id, session_id, MAX(id) AS max_id FROM audit_log
               WHERE agent_id = ?
               GROUP BY agent_id, session_id
               HAVING MAX(timestamp) < ?
                 AND SUM(CASE WHEN kind = 'session_end' THEN 1 ELSE 0 END) > 0`,
            )
          : db.prepare(
              `SELECT agent_id, session_id, MAX(id) AS max_id FROM audit_log
               GROUP BY agent_id, session_id
               HAVING MAX(timestamp) < ?
                 AND SUM(CASE WHEN kind = 'session_end' THEN 1 ELSE 0 END) > 0`,
            );

      const candidates = (
        config.agentId !== undefined
          ? candidateStmt.all(config.agentId, cutoff)
          : candidateStmt.all(cutoff)
      ) as Array<{ agent_id: string; session_id: string; max_id: number }>;

      const chainFollowerStmt = db.prepare(
        `SELECT 1 FROM audit_log WHERE id > ? AND prev_hash IS NOT NULL LIMIT 1`,
      );

      db.transaction(() => {
        for (const { agent_id, session_id, max_id } of candidates) {
          // Skip sessions mid-chain: if any later row is hash-chained, deleting
          // this session would corrupt the audit trail of subsequent sessions.
          if (chainFollowerStmt.get(max_id) !== null) continue;
          db.prepare("DELETE FROM audit_log WHERE agent_id = ? AND session_id = ?").run(
            agent_id,
            session_id,
          );
        }
      })();
    } catch (e: unknown) {
      throw new Error("audit_log: failed to prune old entries", { cause: e });
    }
    // VACUUM is best-effort: SQLITE_BUSY from concurrent readers is expected and harmless.
    try {
      db.prepare("VACUUM").run();
    } catch {
      // Space reclamation deferred to next prune cycle — not a correctness failure.
    }
  }

  function serializeField(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
  }

  function flushBuffer(): void {
    if (buffer.length === 0) return;

    const transaction = db.transaction(() => {
      for (const entry of buffer) {
        insertStmt.run({
          $schemaVersion: entry.schema_version,
          $timestamp: entry.timestamp,
          $sessionId: entry.sessionId,
          $agentId: entry.agentId,
          $turnIndex: entry.turnIndex,
          $kind: entry.kind,
          $request: serializeField(entry.request),
          $response: serializeField(entry.response),
          $error: serializeField(entry.error),
          $durationMs: entry.durationMs,
          $prevHash: entry.prev_hash ?? null,
          $signature: entry.signature ?? null,
          $metadata: serializeField(entry.metadata),
          $canonicalJson: JSON.stringify(entry),
        });
      }
    });

    transaction();
    buffer.length = 0;
  }

  const timer = setInterval(flushBuffer, flushIntervalMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  // Pruning setup — run immediately on creation, then on interval.
  // safePrune catches all errors so the interval callback cannot crash the host process.
  function safePrune(): void {
    try {
      pruneOldEntries();
    } catch (e: unknown) {
      // Retention policy is silently non-enforced when pruning fails — surface the error
      // so operators can detect storage growth before it becomes a capacity incident.
      console.error("[audit-sink-sqlite] retention prune failed:", e);
    }
  }

  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  if (config.retention) {
    safePrune();
    const pruneIntervalMs = config.retention.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    pruneTimer = setInterval(safePrune, pruneIntervalMs);
    if (typeof pruneTimer === "object" && pruneTimer !== null && "unref" in pruneTimer) {
      (pruneTimer as unknown as { unref: () => void }).unref();
    }
  }

  return {
    async log(entry: AuditEntry): Promise<void> {
      buffer.push(entry);
      if (buffer.length >= maxBufferSize) {
        flushBuffer();
      }
    },

    async flush(): Promise<void> {
      flushBuffer();
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      flushBuffer();
      // Full session read, no in-sink cap. A bounded/cursored API would
      // be nice for very long sessions (thousands of audit rows per
      // session), but silently truncating here would mask partial reads
      // from the decision-ledger and /trajectory audit lane. When that
      // becomes necessary, add a proper `queryPage({ sessionId, cursor,
      // limit })` surface and propagate `hasMore` through the ledger.
      //
      // When config.agentId is set (shared-DB mode), scope reads to that
      // agent's rows so one sink cannot observe another agent's audit history
      // via a colliding or reused session ID. Callers needing cross-agent reads
      // (e.g. multi-agent compliance review) should omit agentId from config.
      const rows =
        config.agentId !== undefined
          ? db
              .prepare(
                "SELECT * FROM audit_log WHERE session_id = ? AND agent_id = ? ORDER BY id ASC",
              )
              .all(sessionId, config.agentId)
          : db
              .prepare("SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC")
              .all(sessionId);
      return rows.map(mapRow);
    },

    getEntries(): readonly AuditEntry[] {
      flushBuffer();
      if (config.agentId !== undefined) {
        return (
          db
            .prepare("SELECT * FROM audit_log WHERE agent_id = ? ORDER BY id ASC")
            .all(config.agentId) as unknown[]
        ).map(mapRow);
      }
      return readAllRows(db).map(mapRow);
    },

    close(): void {
      clearInterval(timer);
      clearInterval(pruneTimer);
      flushBuffer();
      db.close();
    },
  };
}
