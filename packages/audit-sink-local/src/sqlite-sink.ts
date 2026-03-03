/**
 * SQLite-backed audit sink with batched inserts.
 *
 * Buffers entries and flushes either when the buffer reaches maxBufferSize
 * or when the flush interval fires, whichever comes first.
 */

import type { Database } from "bun:sqlite";
import type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";
import { openDb } from "@koi/sqlite-utils";
import { createInsertStmt, initAuditSchema, readAllAuditEntries } from "./schema.js";
import type { SqliteAuditSinkConfig } from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BUFFER_SIZE = 100;

/** Apply redaction rules to a serialized string. */
function applyRedaction(text: string, rules: readonly RedactionRule[]): string {
  // let justified: iteratively applying regex replacements requires mutation
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Create a SQLite-backed audit sink with batch inserts.
 *
 * Entries are buffered in memory and flushed to SQLite in batches.
 * Flush triggers: buffer full OR interval timer.
 */
export function createSqliteAuditSink(config: SqliteAuditSinkConfig): AuditSink & {
  /** Flush remaining buffer and close the database. */
  readonly close: () => void;
  /** Read all stored entries (for testing). */
  readonly getEntries: () => readonly AuditEntry[];
} {
  const db: Database = openDb(config.dbPath);
  initAuditSchema(db);

  const insertStmt = createInsertStmt(db);
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const redactionRules = config.redactionRules ?? [];

  // Mutable buffer — never exposed
  const buffer: AuditEntry[] = [];

  function serializeField(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const json = JSON.stringify(value);
    return redactionRules.length > 0 ? applyRedaction(json, redactionRules) : json;
  }

  function flushBuffer(): void {
    if (buffer.length === 0) return;

    const transaction = db.transaction(() => {
      for (const entry of buffer) {
        insertStmt.run({
          $timestamp: entry.timestamp,
          $sessionId: entry.sessionId,
          $agentId: entry.agentId,
          $turnIndex: entry.turnIndex,
          $kind: entry.kind,
          $request: serializeField(entry.request),
          $response: serializeField(entry.response),
          $error: serializeField(entry.error),
          $durationMs: entry.durationMs,
          $metadata: serializeField(entry.metadata),
        });
      }
    });
    transaction();
    buffer.length = 0;
  }

  const timer = setInterval(flushBuffer, flushIntervalMs);
  // Prevent timer from keeping the process alive
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  function mapDbRow(row: {
    readonly timestamp: number;
    readonly session_id: string;
    readonly agent_id: string;
    readonly turn_index: number;
    readonly kind: string;
    readonly request: string | null;
    readonly response: string | null;
    readonly error: string | null;
    readonly duration_ms: number;
    readonly metadata: string | null;
  }): AuditEntry {
    return {
      timestamp: row.timestamp,
      sessionId: row.session_id,
      agentId: row.agent_id,
      turnIndex: row.turn_index,
      kind: row.kind as AuditEntry["kind"],
      durationMs: row.duration_ms,
      ...(row.request !== null ? { request: JSON.parse(row.request) as unknown } : {}),
      ...(row.response !== null ? { response: JSON.parse(row.response) as unknown } : {}),
      ...(row.error !== null ? { error: JSON.parse(row.error) as unknown } : {}),
      ...(row.metadata !== null
        ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> }
        : {}),
    };
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

    getEntries(): readonly AuditEntry[] {
      // Flush first to ensure all buffered entries are in the DB
      flushBuffer();
      const rows = readAllAuditEntries(db);
      return rows.map(mapDbRow);
    },

    close(): void {
      clearInterval(timer);
      flushBuffer();
      db.close();
    },
  };
}
