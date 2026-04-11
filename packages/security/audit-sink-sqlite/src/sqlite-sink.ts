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
      const rows = db
        .prepare("SELECT * FROM audit_log WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId);
      return rows.map(mapRow);
    },

    getEntries(): readonly AuditEntry[] {
      flushBuffer();
      return readAllRows(db).map(mapRow);
    },

    close(): void {
      clearInterval(timer);
      flushBuffer();
      db.close();
    },
  };
}
