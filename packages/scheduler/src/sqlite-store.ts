/**
 * SQLite-backed TaskStore implementation.
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency persistence.
 * Schema auto-created on first use (idempotent).
 */

import type { Database } from "bun:sqlite";
import type {
  CronSchedule,
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduleId,
  ScheduleStore,
  TaskFilter,
  TaskId,
  TaskOptions,
  TaskStatus,
  TaskStore,
} from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TASKS_TABLE = `
CREATE TABLE IF NOT EXISTS koi_tasks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  input       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('spawn', 'dispatch')),
  priority    INTEGER NOT NULL DEFAULT 5,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_letter')),
  created_at  INTEGER NOT NULL,
  scheduled_at INTEGER,
  started_at  INTEGER,
  completed_at INTEGER,
  retries     INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  timeout_ms  INTEGER,
  last_error  TEXT,
  metadata    TEXT
);
`;

const CREATE_SCHEDULES_TABLE = `
CREATE TABLE IF NOT EXISTS koi_schedules (
  id          TEXT PRIMARY KEY,
  expression  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  input       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('spawn', 'dispatch')),
  task_options TEXT,
  timezone    TEXT,
  paused      INTEGER NOT NULL DEFAULT 0
);
`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_koi_tasks_status_priority ON koi_tasks (status, priority, created_at);
`;

// Migration for existing DBs that lack timeout_ms column
const MIGRATE_TIMEOUT_MS = `
ALTER TABLE koi_tasks ADD COLUMN timeout_ms INTEGER;
`;

// ---------------------------------------------------------------------------
// Row ↔ ScheduledTask mapping
// ---------------------------------------------------------------------------

interface TaskRow {
  readonly id: string;
  readonly agent_id: string;
  readonly input: string;
  readonly mode: string;
  readonly priority: number;
  readonly status: string;
  readonly created_at: number;
  readonly scheduled_at: number | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly retries: number;
  readonly max_retries: number;
  readonly timeout_ms: number | null;
  readonly last_error: string | null;
  readonly metadata: string | null;
}

interface ScheduleRow {
  readonly id: string;
  readonly expression: string;
  readonly agent_id: string;
  readonly input: string;
  readonly mode: string;
  readonly task_options: string | null;
  readonly timezone: string | null;
  readonly paused: number;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: taskId(row.id),
    agentId: agentId(row.agent_id),
    input: JSON.parse(row.input) as EngineInput,
    mode: row.mode as "spawn" | "dispatch",
    priority: row.priority,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    retries: row.retries,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms ?? undefined,
    lastError: row.last_error !== null ? (JSON.parse(row.last_error) as KoiError) : undefined,
    metadata:
      row.metadata !== null
        ? (JSON.parse(row.metadata) as Readonly<Record<string, unknown>>)
        : undefined,
  };
}

function rowToSchedule(row: ScheduleRow): CronSchedule {
  return {
    id: scheduleId(row.id),
    expression: row.expression,
    agentId: agentId(row.agent_id),
    input: JSON.parse(row.input) as EngineInput,
    mode: row.mode as "spawn" | "dispatch",
    taskOptions:
      row.task_options !== null ? (JSON.parse(row.task_options) as TaskOptions) : undefined,
    timezone: row.timezone ?? undefined,
    paused: row.paused !== 0,
  };
}

// ---------------------------------------------------------------------------
// Public type — extends TaskStore with purge capability
// ---------------------------------------------------------------------------

/** SqliteTaskStore narrows TaskStore to sync returns and adds purge() + ScheduleStore. */
export type SqliteTaskStore = TaskStore &
  ScheduleStore & {
    /** Delete completed/dead_letter tasks older than the given timestamp. */
    readonly purge: (olderThanMs: number) => void;
  };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSqliteTaskStore(db: Database): SqliteTaskStore {
  // Auto-create schema
  db.run(CREATE_TASKS_TABLE);
  db.run(CREATE_INDEX);
  db.run(CREATE_SCHEDULES_TABLE);

  // Migrate existing DBs: add timeout_ms column if missing
  try {
    db.run(MIGRATE_TIMEOUT_MS);
  } catch {
    // Column already exists — ignore
  }

  // Prepared statements
  const insertStmt = db.prepare<
    void,
    {
      $id: string;
      $agent_id: string;
      $input: string;
      $mode: string;
      $priority: number;
      $status: string;
      $created_at: number;
      $scheduled_at: number | null;
      $started_at: number | null;
      $completed_at: number | null;
      $retries: number;
      $max_retries: number;
      $timeout_ms: number | null;
      $last_error: string | null;
      $metadata: string | null;
    }
  >(
    `INSERT OR REPLACE INTO koi_tasks
      (id, agent_id, input, mode, priority, status, created_at, scheduled_at, started_at, completed_at, retries, max_retries, timeout_ms, last_error, metadata)
     VALUES ($id, $agent_id, $input, $mode, $priority, $status, $created_at, $scheduled_at, $started_at, $completed_at, $retries, $max_retries, $timeout_ms, $last_error, $metadata)`,
  );

  const loadStmt = db.prepare<TaskRow, { $id: string }>("SELECT * FROM koi_tasks WHERE id = $id");

  const removeStmt = db.prepare<void, { $id: string }>("DELETE FROM koi_tasks WHERE id = $id");

  const loadPendingStmt = db.prepare<TaskRow, []>(
    "SELECT * FROM koi_tasks WHERE status = 'pending' ORDER BY priority ASC, created_at ASC",
  );

  // P3 fix: single prepared statement with COALESCE for updateStatus hot path
  const updateStatusStmt = db.prepare<
    void,
    {
      $id: string;
      $status: string;
      $started_at: number | null;
      $completed_at: number | null;
      $last_error: string | null;
      $retries: number | null;
    }
  >(
    `UPDATE koi_tasks SET
      status = $status,
      started_at = COALESCE($started_at, started_at),
      completed_at = COALESCE($completed_at, completed_at),
      last_error = COALESCE($last_error, last_error),
      retries = COALESCE($retries, retries)
    WHERE id = $id`,
  );

  // P5 fix: prepared statement for TTL purge of terminal tasks
  const purgeStmt = db.prepare<void, { $before: number }>(
    "DELETE FROM koi_tasks WHERE status IN ('completed', 'dead_letter') AND completed_at < $before",
  );

  // Schedule statements
  const insertScheduleStmt = db.prepare<
    void,
    {
      $id: string;
      $expression: string;
      $agent_id: string;
      $input: string;
      $mode: string;
      $task_options: string | null;
      $timezone: string | null;
      $paused: number;
    }
  >(
    `INSERT OR REPLACE INTO koi_schedules
      (id, expression, agent_id, input, mode, task_options, timezone, paused)
     VALUES ($id, $expression, $agent_id, $input, $mode, $task_options, $timezone, $paused)`,
  );

  const removeScheduleStmt = db.prepare<void, { $id: string }>(
    "DELETE FROM koi_schedules WHERE id = $id",
  );

  const loadSchedulesStmt = db.prepare<ScheduleRow, []>("SELECT * FROM koi_schedules");

  function save(task: ScheduledTask): void {
    insertStmt.run({
      $id: task.id,
      $agent_id: task.agentId,
      $input: JSON.stringify(task.input),
      $mode: task.mode,
      $priority: task.priority,
      $status: task.status,
      $created_at: task.createdAt,
      $scheduled_at: task.scheduledAt ?? null,
      $started_at: task.startedAt ?? null,
      $completed_at: task.completedAt ?? null,
      $retries: task.retries,
      $max_retries: task.maxRetries,
      $timeout_ms: task.timeoutMs ?? null,
      $last_error: task.lastError !== undefined ? JSON.stringify(task.lastError) : null,
      $metadata: task.metadata !== undefined ? JSON.stringify(task.metadata) : null,
    });
  }

  function load(id: TaskId): ScheduledTask | undefined {
    const row = loadStmt.get({ $id: id });
    return row !== null ? rowToTask(row) : undefined;
  }

  function remove(id: TaskId): void {
    removeStmt.run({ $id: id });
  }

  // P3 fix: use prepared statement instead of dynamic SQL construction
  function updateStatus(
    id: TaskId,
    status: TaskStatus,
    patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
  ): void {
    updateStatusStmt.run({
      $id: id,
      $status: status,
      $started_at: patch?.startedAt ?? null,
      $completed_at: patch?.completedAt ?? null,
      $last_error: patch?.lastError !== undefined ? JSON.stringify(patch.lastError) : null,
      $retries: patch?.retries ?? null,
    });
  }

  // P7 fix: finalize dynamically-prepared statements after use
  function query(filter: TaskFilter): readonly ScheduledTask[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (filter.status !== undefined) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter.agentId !== undefined) {
      conditions.push("agent_id = ?");
      values.push(filter.agentId);
    }
    if (filter.priority !== undefined) {
      conditions.push("priority = ?");
      values.push(filter.priority);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter.limit !== undefined ? `LIMIT ${String(filter.limit)}` : "";
    const sql = `SELECT * FROM koi_tasks ${where} ORDER BY priority ASC, created_at ASC ${limitClause}`;

    const stmt = db.prepare<TaskRow, (string | number)[]>(sql);
    try {
      return stmt.all(...values).map(rowToTask);
    } finally {
      stmt.finalize();
    }
  }

  function loadPending(): readonly ScheduledTask[] {
    return loadPendingStmt.all().map(rowToTask);
  }

  // P5 fix: purge terminal tasks older than the given duration
  function purge(olderThanMs: number): void {
    purgeStmt.run({ $before: Date.now() - olderThanMs });
  }

  // ---------------------------------------------------------------------------
  // ScheduleStore implementation
  // ---------------------------------------------------------------------------

  function saveSchedule(schedule: CronSchedule): void {
    insertScheduleStmt.run({
      $id: schedule.id,
      $expression: schedule.expression,
      $agent_id: schedule.agentId,
      $input: JSON.stringify(schedule.input),
      $mode: schedule.mode,
      $task_options:
        schedule.taskOptions !== undefined ? JSON.stringify(schedule.taskOptions) : null,
      $timezone: schedule.timezone ?? null,
      $paused: schedule.paused ? 1 : 0,
    });
  }

  function removeSchedule(id: ScheduleId): void {
    removeScheduleStmt.run({ $id: id });
  }

  function loadSchedules(): readonly CronSchedule[] {
    return loadSchedulesStmt.all().map(rowToSchedule);
  }

  async function dispose(): Promise<void> {
    insertStmt.finalize();
    loadStmt.finalize();
    removeStmt.finalize();
    loadPendingStmt.finalize();
    updateStatusStmt.finalize();
    purgeStmt.finalize();
    insertScheduleStmt.finalize();
    removeScheduleStmt.finalize();
    loadSchedulesStmt.finalize();
  }

  return {
    save,
    load,
    remove,
    updateStatus,
    query,
    loadPending,
    purge,
    saveSchedule,
    removeSchedule,
    loadSchedules,
    [Symbol.asyncDispose]: dispose,
  };
}
