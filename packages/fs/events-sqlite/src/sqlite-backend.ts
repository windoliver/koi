/**
 * SQLite-backed EventBackend implementation.
 *
 * Uses bun:sqlite for single-node deployments with durable persistence,
 * crash recovery via replay, and audit trail.
 *
 * WAL mode, STRICT tables, prepared statements, and parameterized queries.
 */

import type { Database } from "bun:sqlite";
import type {
  DeadLetterEntry,
  DeadLetterFilter,
  EventBackend,
  EventBackendConfig,
  EventEnvelope,
  EventInput,
  KoiError,
  ReadOptions,
  ReadResult,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";
import { conflict, validation } from "@koi/core";
import { createDeliveryManager } from "@koi/event-delivery";
import { generateUlid } from "@koi/hash";
import { mapSqliteError, openDb, wrapSqlite } from "@koi/sqlite-utils";
import { applyEventMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SqliteEventBackendConfig extends EventBackendConfig {
  /** File path — creates and owns Database lifecycle. */
  readonly dbPath?: string | undefined;
  /** Caller-injected Database — caller owns lifecycle. */
  readonly db?: Database | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS_PER_STREAM = 10_000;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface EventRow {
  readonly stream_id: string;
  readonly sequence: number;
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly data: string;
  readonly metadata: string | null;
}

interface MaxSeqRow {
  readonly max_seq: number;
}

interface CountRow {
  readonly cnt: number;
}

interface MinSeqRow {
  readonly min_seq: number | null;
}

interface DlqRow {
  readonly id: string;
  readonly subscription_name: string;
  readonly event_data: string;
  readonly error_message: string;
  readonly attempts: number;
  readonly dead_lettered_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    streamId: row.stream_id,
    type: row.type,
    timestamp: row.timestamp,
    sequence: row.sequence,
    data: JSON.parse(row.data) as unknown,
    metadata:
      row.metadata !== null
        ? (JSON.parse(row.metadata) as Readonly<Record<string, unknown>>)
        : undefined,
  };
}

function mapDlqRowToEntry(row: DlqRow): DeadLetterEntry {
  return {
    id: row.id,
    event: JSON.parse(row.event_data) as EventEnvelope,
    subscriptionName: row.subscription_name,
    error: row.error_message,
    attempts: row.attempts,
    deadLetteredAt: row.dead_lettered_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed EventBackend.
 *
 * Accepts either a file path (creates and owns the Database) or an
 * injected Database instance (caller owns lifecycle). Applies schema
 * migrations on creation.
 */
export function createSqliteEventBackend(config: SqliteEventBackendConfig = {}): EventBackend {
  const ownsDb = config.db === undefined;
  const db = config.db ?? openDb(config.dbPath ?? ":memory:");
  const maxPerStream = config.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
  const eventTtlMs = config.eventTtlMs;

  applyEventMigrations(db);

  // -------------------------------------------------------------------------
  // Prepared statements (eager)
  // -------------------------------------------------------------------------

  const insertEventStmt = db.query<
    void,
    [string, number, string, string, number, string, string | null]
  >(
    `INSERT INTO events (stream_id, sequence, id, type, timestamp, data, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const readMaxSeqStmt = db.query<MaxSeqRow, [string]>(
    "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events WHERE stream_id = ?",
  );

  const readEventsForwardStmt = db.query<EventRow, [string, number, number, number]>(
    `SELECT stream_id, sequence, id, type, timestamp, data, metadata
     FROM events WHERE stream_id = ? AND sequence >= ? AND sequence < ?
     ORDER BY sequence ASC LIMIT ?`,
  );

  const readEventsBackwardStmt = db.query<EventRow, [string, number, number, number]>(
    `SELECT stream_id, sequence, id, type, timestamp, data, metadata
     FROM events WHERE stream_id = ? AND sequence >= ? AND sequence < ?
     ORDER BY sequence DESC LIMIT ?`,
  );

  const streamCountStmt = db.query<CountRow, [string]>(
    "SELECT COUNT(*) AS cnt FROM events WHERE stream_id = ?",
  );

  const streamCountWithTtlStmt = db.query<CountRow, [string, number]>(
    "SELECT COUNT(*) AS cnt FROM events WHERE stream_id = ? AND timestamp > ?",
  );

  const firstSeqStmt = db.query<MinSeqRow, [string]>(
    "SELECT MIN(sequence) AS min_seq FROM events WHERE stream_id = ?",
  );

  const firstSeqWithTtlStmt = db.query<MinSeqRow, [string, number]>(
    "SELECT MIN(sequence) AS min_seq FROM events WHERE stream_id = ? AND timestamp > ?",
  );

  const evictByCountStmt = db.query<void, [string, string, number]>(
    `DELETE FROM events WHERE stream_id = ? AND sequence <= (
       SELECT sequence FROM events WHERE stream_id = ?
       ORDER BY sequence ASC
       LIMIT 1 OFFSET ?
     )`,
  );

  const evictByTtlStmt = db.query<void, [string, number]>(
    "DELETE FROM events WHERE stream_id = ? AND timestamp <= ?",
  );

  const upsertPositionStmt = db.query<void, [string, string, number, number]>(
    `INSERT INTO subscriptions (subscription_name, stream_id, position, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(subscription_name) DO UPDATE SET position = excluded.position`,
  );

  const insertDlqStmt = db.query<void, [string, string, string, string, number, number]>(
    `INSERT INTO dead_letters (id, subscription_name, event_data, error_message, attempts, dead_lettered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const queryDlqAllStmt = db.query<DlqRow, []>(
    "SELECT id, subscription_name, event_data, error_message, attempts, dead_lettered_at FROM dead_letters",
  );

  const queryDlqByStreamStmt = db.query<DlqRow, [string]>(
    `SELECT id, subscription_name, event_data, error_message, attempts, dead_lettered_at
     FROM dead_letters WHERE id IN (
       SELECT dl.id FROM dead_letters dl
       WHERE json_extract(dl.event_data, '$.streamId') = ?
     )`,
  );

  const queryDlqBySubStmt = db.query<DlqRow, [string]>(
    `SELECT id, subscription_name, event_data, error_message, attempts, dead_lettered_at
     FROM dead_letters WHERE subscription_name = ?`,
  );

  const queryDlqByStreamAndSubStmt = db.query<DlqRow, [string, string]>(
    `SELECT id, subscription_name, event_data, error_message, attempts, dead_lettered_at
     FROM dead_letters WHERE subscription_name = ?
     AND json_extract(event_data, '$.streamId') = ?`,
  );

  const deleteDlqStmt = db.query<void, [string]>("DELETE FROM dead_letters WHERE id = ?");

  const deleteDlqAllStmt = db.query<void, []>("DELETE FROM dead_letters");

  const deleteDlqBySubStmt = db.query<void, [string]>(
    "DELETE FROM dead_letters WHERE subscription_name = ?",
  );

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function evictIfNeeded(streamId: string): void {
    // TTL eviction
    if (eventTtlMs !== undefined) {
      const cutoff = Date.now() - eventTtlMs;
      evictByTtlStmt.run(streamId, cutoff);
    }

    // FIFO eviction — delete excess events beyond maxPerStream
    const countRow = streamCountStmt.get(streamId);
    const count = countRow?.cnt ?? 0;
    const excess = count - maxPerStream;
    if (excess > 0) {
      // Delete events up to and including the Nth event (0-indexed offset = excess - 1)
      evictByCountStmt.run(streamId, streamId, excess - 1);
    }
  }

  function readStreamEvents(streamId: string, fromSequence: number): readonly EventEnvelope[] {
    const rows = readEventsForwardStmt.all(
      streamId,
      fromSequence + 1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    const envelopes = rows.map(mapRowToEnvelope);
    if (eventTtlMs !== undefined) {
      const cutoff = ttlCutoff();
      return envelopes.filter((e) => e.timestamp > cutoff);
    }
    return envelopes;
  }

  function ttlCutoff(): number {
    if (eventTtlMs === undefined) return 0;
    return Date.now() - eventTtlMs;
  }

  // -------------------------------------------------------------------------
  // Append transaction
  // -------------------------------------------------------------------------

  const appendTx = db.transaction(
    (streamId: string, event: EventInput): Result<EventEnvelope, KoiError> => {
      // CAS check
      const maxSeqRow = readMaxSeqStmt.get(streamId);
      const currentSeq = maxSeqRow?.max_seq ?? 0;

      if (event.expectedSequence !== undefined && currentSeq !== event.expectedSequence) {
        return {
          ok: false,
          error: conflict(
            streamId,
            `Stream "${streamId}" sequence mismatch: expected ${String(event.expectedSequence)}, current is ${String(currentSeq)}`,
          ),
        };
      }

      const seq = currentSeq + 1;
      const envelope: EventEnvelope = {
        id: generateUlid(),
        streamId,
        type: event.type,
        timestamp: Date.now(),
        sequence: seq,
        data: event.data,
        metadata: event.metadata,
      };

      const dataJson = JSON.stringify(envelope.data);
      const metadataJson =
        envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null;

      insertEventStmt.run(
        streamId,
        seq,
        envelope.id,
        envelope.type,
        envelope.timestamp,
        dataJson,
        metadataJson,
      );

      evictIfNeeded(streamId);

      return { ok: true, value: envelope };
    },
  );

  // -------------------------------------------------------------------------
  // Delivery manager
  // -------------------------------------------------------------------------

  const delivery = createDeliveryManager({
    persistPosition: (subscriptionName, sequence) => {
      upsertPositionStmt.run(subscriptionName, "", sequence, Date.now());
    },
    persistDeadLetter: (entry) => {
      insertDlqStmt.run(
        entry.id,
        entry.subscriptionName,
        JSON.stringify(entry.event),
        entry.error,
        entry.attempts,
        entry.deadLetteredAt,
      );
    },
    readStream: readStreamEvents,
    removeDeadLetter: (entryId) => {
      deleteDlqStmt.run(entryId);
      return true;
    },
  });

  // -------------------------------------------------------------------------
  // EventBackend implementation
  // -------------------------------------------------------------------------

  const backend: EventBackend = {
    append(streamId: string, event: EventInput): Result<EventEnvelope, KoiError> {
      if (streamId === "") {
        return { ok: false, error: validation("streamId must not be empty") };
      }
      if (event.type === "") {
        return { ok: false, error: validation("event type must not be empty") };
      }

      try {
        const result = appendTx(streamId, event);
        if (result.ok) {
          delivery.notifySubscribers(streamId, result.value);
        }
        return result;
      } catch (e: unknown) {
        return { ok: false, error: mapSqliteError(e, "append") };
      }
    },

    read(streamId: string, options?: ReadOptions): Result<ReadResult, KoiError> {
      const from = options?.fromSequence ?? 1;
      const to = options?.toSequence ?? Number.MAX_SAFE_INTEGER;
      const direction = options?.direction ?? "forward";
      const limit = options?.limit ?? Number.MAX_SAFE_INTEGER;
      const typeFilter = options?.types !== undefined ? new Set(options.types) : undefined;
      const needsPostFilter = eventTtlMs !== undefined || typeFilter !== undefined;

      try {
        const stmt = direction === "backward" ? readEventsBackwardStmt : readEventsForwardStmt;

        if (!needsPostFilter) {
          // Fast path: no post-fetch filtering, limit+1 sentinel is reliable
          const fetchLimit = limit < Number.MAX_SAFE_INTEGER ? limit + 1 : limit;
          const rows = stmt.all(streamId, from, to, fetchLimit);
          const envelopes = rows.map(mapRowToEnvelope);

          if (limit < Number.MAX_SAFE_INTEGER && envelopes.length > limit) {
            return {
              ok: true,
              value: { events: envelopes.slice(0, limit), hasMore: true },
            };
          }
          return { ok: true, value: { events: envelopes, hasMore: false } };
        }

        // Slow path: TTL and/or type filters applied after fetch.
        // Over-fetch in batches to collect enough matching events and
        // reliably detect whether more exist beyond the requested limit.
        const cutoff = eventTtlMs !== undefined ? ttlCutoff() : 0;
        const batchSize =
          limit < Number.MAX_SAFE_INTEGER ? (limit + 1) * 2 : Number.MAX_SAFE_INTEGER;
        const collected: EventEnvelope[] = [];
        // let is required: range bounds narrow across batches
        // SQL: WHERE sequence >= rangeFrom AND sequence < rangeTo
        let rangeFrom = from;
        let rangeTo = to;
        // let is required: flag set when DB rows are exhausted
        let dbExhausted = false;

        while (collected.length <= limit) {
          const rows = stmt.all(streamId, rangeFrom, rangeTo, batchSize);
          if (rows.length === 0) {
            dbExhausted = true;
            break;
          }

          for (const row of rows) {
            const env = mapRowToEnvelope(row);
            if (eventTtlMs !== undefined && env.timestamp <= cutoff) continue;
            if (typeFilter !== undefined && !typeFilter.has(env.type)) continue;
            collected.push(env);
            if (collected.length > limit) break;
          }

          // Narrow the range past the rows we already fetched.
          // Forward: last row has highest sequence → advance lower bound
          // Backward: last row (ORDER BY DESC) has lowest sequence → lower upper bound
          const lastRow = rows[rows.length - 1];
          if (lastRow === undefined) {
            dbExhausted = true;
            break;
          }
          if (direction === "backward") {
            rangeTo = lastRow.sequence;
          } else {
            rangeFrom = lastRow.sequence + 1;
          }

          if (rows.length < batchSize) {
            dbExhausted = true;
            break;
          }
        }

        if (limit < Number.MAX_SAFE_INTEGER && collected.length > limit) {
          return {
            ok: true,
            value: { events: collected.slice(0, limit), hasMore: true },
          };
        }
        return {
          ok: true,
          value: { events: collected, hasMore: !dbExhausted },
        };
      } catch (e: unknown) {
        return { ok: false, error: mapSqliteError(e, "read") };
      }
    },

    subscribe(options: SubscribeOptions): SubscriptionHandle {
      return delivery.subscribe(options);
    },

    queryDeadLetters(filter?: DeadLetterFilter): Result<readonly DeadLetterEntry[], KoiError> {
      return wrapSqlite(() => {
        // let is required: rows are progressively filtered
        let rows: readonly DlqRow[];

        if (filter?.streamId !== undefined && filter?.subscriptionName !== undefined) {
          rows = queryDlqByStreamAndSubStmt.all(filter.subscriptionName, filter.streamId);
        } else if (filter?.subscriptionName !== undefined) {
          rows = queryDlqBySubStmt.all(filter.subscriptionName);
        } else if (filter?.streamId !== undefined) {
          rows = queryDlqByStreamStmt.all(filter.streamId);
        } else {
          rows = queryDlqAllStmt.all();
        }

        // Also merge in-memory DLQ entries from delivery manager
        const dbEntries = rows.map(mapDlqRowToEntry);
        const memResult = delivery.queryDeadLetters(filter);
        const memEntries = memResult.ok ? memResult.value : [];

        // Deduplicate by id (prefer DB entries)
        const seen = new Set(dbEntries.map((e) => e.id));
        const merged = [...dbEntries, ...memEntries.filter((e) => !seen.has(e.id))];

        if (filter?.limit !== undefined) {
          return merged.slice(0, filter.limit);
        }

        return merged;
      }, "queryDeadLetters");
    },

    retryDeadLetter(
      entryId: string,
    ): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>> {
      return delivery.retryDeadLetter(entryId);
    },

    purgeDeadLetters(filter?: DeadLetterFilter): Result<void, KoiError> {
      // Purge from in-memory delivery manager
      delivery.purgeDeadLetters(filter);

      // Purge from SQLite
      return wrapSqlite(() => {
        if (filter === undefined) {
          deleteDlqAllStmt.run();
        } else if (filter.subscriptionName !== undefined) {
          deleteDlqBySubStmt.run(filter.subscriptionName);
        } else {
          // For stream-based filtering, delete matching rows manually
          const rows =
            filter.streamId !== undefined ? queryDlqByStreamStmt.all(filter.streamId) : [];
          for (const row of rows) {
            deleteDlqStmt.run(row.id);
          }
        }
      }, "purgeDeadLetters");
    },

    streamLength(streamId: string): number {
      if (eventTtlMs !== undefined) {
        const row = streamCountWithTtlStmt.get(streamId, ttlCutoff());
        return row?.cnt ?? 0;
      }
      const row = streamCountStmt.get(streamId);
      return row?.cnt ?? 0;
    },

    firstSequence(streamId: string): number {
      if (eventTtlMs !== undefined) {
        const row = firstSeqWithTtlStmt.get(streamId, ttlCutoff());
        return row?.min_seq ?? 0;
      }
      const row = firstSeqStmt.get(streamId);
      return row?.min_seq ?? 0;
    },

    close(): void {
      delivery.closeAll();
      try {
        db.run("PRAGMA optimize");
      } catch {
        // best-effort optimize before close
      }
      if (ownsDb) {
        db.close();
      }
    },
  };

  return backend;
}
