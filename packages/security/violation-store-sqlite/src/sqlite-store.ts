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
import { createInsertStmt, initViolationSchema, type ViolationRow } from "./schema.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BUFFER_SIZE = 100;
// Hard cap on the in-memory backlog that survives across failed flushes.
// Without a cap, sustained write failures (locked DB, disk full) would
// grow the buffer unboundedly. When exceeded we drop the OLDEST entries
// and log a loud count — keeping the most-recent audit signal, since
// governance monitors usually react to the tail. Operators who need
// zero-loss guarantees must choose a durable transport upstream.
const MAX_BUFFER_BACKLOG = 10_000;
// Retries close() attempts to drain the buffer before giving up. Short
// because the governance hot path already recorded the violations via
// `onViolation` subscribers — the SQLite trail is the history backfill,
// not the primary signal.
const CLOSE_FLUSH_ATTEMPTS = 3;

interface BufferedEntry {
  readonly rule: string;
  readonly severity: ViolationSeverity;
  readonly message: string;
  /** Pre-serialized at record() time to isolate per-entry serialization
   *  failures from batch flushes. A malformed context (BigInt, circular
   *  reference) that failed to serialize is stored here as `null` so
   *  the batch cannot poison-drop healthy siblings. */
  readonly contextJson: string | null;
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

function mapRow(row: ViolationRow): Violation {
  let context: Record<string, unknown> | undefined;
  if (row.context_json !== null) {
    try {
      context = JSON.parse(row.context_json) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `violations: malformed context_json for row id=${row.id}: ${String(row.context_json).slice(0, 80)}`,
        { cause: err },
      );
    }
  }
  return {
    rule: row.rule,
    severity: row.severity as ViolationSeverity,
    message: row.message,
    ...(context !== undefined ? { context } : {}),
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
  /** Close and drain the buffer. Returns a machine-readable outcome:
   *  `droppedCount` is the number of buffered violations NOT persisted
   *  (either evicted by the backlog cap or still buffered after all
   *  retries failed). Callers that configured an explicit path can
   *  fail-closed on non-zero — warn-only logging would hide evidence
   *  loss during the exact failure modes operators need forensics. */
  readonly close: () => { readonly droppedCount: number };
  /** Total violations evicted by the backlog-cap policy since open.
   *  Read any time; useful for health checks and metrics. */
  readonly droppedCount: () => number;
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
  // Idempotency latch: close() may be invoked from multiple parallel
  // paths (runtime.dispose() manifest hook + shutdownBackgroundTasks in
  // TUI hosts). Second call is a no-op; bun:sqlite throws on
  // double-close so we short-circuit before touching the handle.
  // let: justified — flipped on first close.
  let isClosed = false;
  // Cumulative count of buffered violations evicted by the backlog cap.
  // Exposed via `droppedCount()` and returned from `close()` so callers
  // configured with explicit-path fail-closed semantics can surface a
  // hard health signal rather than trusting warn-only logs.
  // let: justified — incremented inside flushBuffer on cap eviction.
  let evictedCount = 0;

  // Flush attempts MUST NOT throw into callers. Three call sites — timer
  // callback, record() when buffer is full, and close() — would all push
  // the exception into paths that cannot handle it: an `onViolation`
  // governance callback, a setInterval unhandled rejection (process
  // crash), or a shutdown sequence. Returns a bool so close() can
  // retry-until-drained without adding a separate result channel.
  //
  // On transient SQLite failures we keep the buffer intact so the next
  // tick retries. `MAX_BUFFER_BACKLOG` bounds the retained backlog —
  // when sustained failures push us past that cap we drop the OLDEST
  // entries and log a loud count so the loss is visible rather than
  // surfacing as an OOM later.
  function flushBuffer(): boolean {
    if (buffer.length === 0) return true;
    const snapshot = buffer.slice();
    try {
      const tx = db.transaction(() => {
        for (const e of snapshot) {
          insertStmt.run({
            $timestamp: e.timestamp,
            $rule: e.rule,
            $severity: e.severity,
            $message: e.message,
            $contextJson: e.contextJson,
            $agentId: e.agentId,
            $sessionId: e.sessionId ?? null,
          });
        }
      });
      tx();
      // Only drop on transaction success. Splice from the front in case
      // record() appended more entries while the tx was mid-flight.
      buffer.splice(0, snapshot.length);
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[violation-store-sqlite] flush of ${snapshot.length} entries failed; retained in buffer: ${message}`,
      );
      if (buffer.length > MAX_BUFFER_BACKLOG) {
        const overflow = buffer.length - MAX_BUFFER_BACKLOG;
        buffer.splice(0, overflow);
        evictedCount += overflow;
        console.warn(
          `[violation-store-sqlite] buffer backlog exceeded ${MAX_BUFFER_BACKLOG}; dropped ${overflow} oldest entries to bound memory (total dropped: ${evictedCount}).`,
        );
      }
      return false;
    }
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
      // Serialize context eagerly so a malformed context (BigInt,
      // circular reference, other JSON.stringify throwers) is caught
      // here and quarantined to THIS entry only. Batch flushes stay
      // pure data writes; one bad violation can no longer poison a
      // whole buffer snapshot and cascade into backlog-cap drops of
      // unrelated entries.
      let contextJson: string | null = null;
      if (violation.context !== undefined) {
        try {
          contextJson = JSON.stringify(violation.context);
        } catch (err) {
          console.warn(
            `[violation-store-sqlite] could not serialize context for rule="${violation.rule}"; storing row with context=null: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          contextJson = null;
        }
      }
      buffer.push({
        rule: violation.rule,
        severity: violation.severity,
        message: violation.message,
        contextJson,
        agentId: agentIdArg,
        sessionId,
        timestamp,
      });
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
    close(): { readonly droppedCount: number } {
      if (isClosed) return { droppedCount: evictedCount };
      isClosed = true;
      clearInterval(timer);
      // Retry the final drain a few times before closing the DB. The
      // old behavior flushed once and silently dropped anything the
      // attempt didn't land. If all attempts fail, attribute the
      // still-buffered entries to evictedCount so callers see the
      // total loss as a single machine-readable number.
      let drained = false;
      for (let i = 0; i < CLOSE_FLUSH_ATTEMPTS; i++) {
        if (flushBuffer()) {
          drained = true;
          break;
        }
      }
      if (!drained && buffer.length > 0) {
        evictedCount += buffer.length;
        console.warn(
          `[violation-store-sqlite] close() giving up after ${CLOSE_FLUSH_ATTEMPTS} attempts — ${buffer.length} buffered entries were not persisted (total dropped: ${evictedCount}).`,
        );
        buffer.length = 0;
      }
      db.close();
      return { droppedCount: evictedCount };
    },
    droppedCount(): number {
      return evictedCount;
    },
  };
}
