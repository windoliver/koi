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
          $contextJson:
            e.violation.context !== undefined ? JSON.stringify(e.violation.context) : null,
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
