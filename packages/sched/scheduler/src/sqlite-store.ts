/**
 * SQLite-backed persistence stores for @koi/scheduler.
 *
 * Provides TaskStore, ScheduleStore, and RunStore implementations
 * using bun:sqlite (sync by default, awaitable via the interface).
 *
 * All statements are prepared upfront for performance.
 * JSON serialization is used for structured fields (input, lastError, metadata, result).
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  AgentId,
  CronSchedule,
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduleId,
  ScheduleStore,
  TaskFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskStore,
} from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TASK_DDL = `
CREATE TABLE IF NOT EXISTS koi_tasks (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  input        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  scheduled_at INTEGER,
  started_at   INTEGER,
  completed_at INTEGER,
  retries      INTEGER NOT NULL DEFAULT 0,
  max_retries  INTEGER NOT NULL DEFAULT 3,
  timeout_ms   INTEGER,
  last_error   TEXT,
  metadata     TEXT
)`;

const SCHEDULE_DDL = `
CREATE TABLE IF NOT EXISTS koi_schedules (
  id           TEXT PRIMARY KEY,
  expression   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  input        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  task_options TEXT,
  timezone     TEXT,
  paused       INTEGER NOT NULL DEFAULT 0
)`;

const RUN_DDL = `
CREATE TABLE IF NOT EXISTS koi_task_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  completed_at   INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  retry_attempt  INTEGER NOT NULL,
  error          TEXT,
  result         TEXT,
  UNIQUE(task_id, retry_attempt)
)`;

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
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

interface RunRow {
  readonly id: string;
  readonly task_id: string;
  readonly agent_id: string;
  readonly status: string;
  readonly started_at: number;
  readonly completed_at: number;
  readonly duration_ms: number;
  readonly retry_attempt: number;
  readonly error: string | null;
  readonly result: string | null;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToTask(row: TaskRow): ScheduledTask {
  const parsed: unknown = JSON.parse(row.input);
  const lastError: KoiError | undefined =
    row.last_error !== null ? (JSON.parse(row.last_error) as KoiError) : undefined;
  const metadata: Readonly<Record<string, unknown>> | undefined =
    row.metadata !== null
      ? (JSON.parse(row.metadata) as Readonly<Record<string, unknown>>)
      : undefined;

  const task: ScheduledTask = {
    id: taskId(row.id),
    agentId: agentId(row.agent_id),
    input: parsed as EngineInput,
    mode: row.mode as "spawn" | "dispatch",
    priority: row.priority,
    status: row.status as ScheduledTaskStatus,
    createdAt: row.created_at,
    retries: row.retries,
    maxRetries: row.max_retries,
    ...(row.scheduled_at !== null ? { scheduledAt: row.scheduled_at } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.timeout_ms !== null ? { timeoutMs: row.timeout_ms } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
  return task;
}

function rowToSchedule(row: ScheduleRow): CronSchedule {
  const input: EngineInput = JSON.parse(row.input) as EngineInput;
  const taskOptions: TaskOptions | undefined =
    row.task_options !== null ? (JSON.parse(row.task_options) as TaskOptions) : undefined;

  const sched: CronSchedule = {
    id: scheduleId(row.id),
    expression: row.expression,
    agentId: agentId(row.agent_id),
    input,
    mode: row.mode as "spawn" | "dispatch",
    paused: row.paused !== 0,
    ...(taskOptions !== undefined ? { taskOptions } : {}),
    ...(row.timezone !== null ? { timezone: row.timezone } : {}),
  };
  return sched;
}

function rowToRunRecord(row: RunRow): TaskRunRecord {
  const result: unknown = row.result !== null ? (JSON.parse(row.result) as unknown) : undefined;

  const record: TaskRunRecord = {
    taskId: taskId(row.task_id),
    agentId: agentId(row.agent_id),
    status: row.status as "completed" | "failed",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    retryAttempt: row.retry_attempt,
    ...(row.error !== null ? { error: row.error } : {}),
    ...(result !== undefined ? { result } : {}),
  };
  return record;
}

// ---------------------------------------------------------------------------
// SqliteTaskStore
// ---------------------------------------------------------------------------

export function createSqliteTaskStore(db: Database): TaskStore {
  db.prepare(TASK_DDL).run();

  const saveStmt = db.prepare(`
    INSERT OR REPLACE INTO koi_tasks
      (id, agent_id, input, mode, priority, status, created_at,
       scheduled_at, started_at, completed_at, retries, max_retries,
       timeout_ms, last_error, metadata)
    VALUES ($id, $agent_id, $input, $mode, $priority, $status, $created_at,
            $scheduled_at, $started_at, $completed_at, $retries, $max_retries,
            $timeout_ms, $last_error, $metadata)
  `);

  const loadStmt = db.prepare(`
    SELECT * FROM koi_tasks WHERE id = $id
  `);

  const removeStmt = db.prepare(`
    DELETE FROM koi_tasks WHERE id = $id
  `);

  const loadPendingStmt = db.prepare(`
    SELECT * FROM koi_tasks WHERE status IN ('pending', 'running')
    ORDER BY priority ASC, created_at ASC
  `);

  function save(task: ScheduledTask): void {
    saveStmt.run({
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
    const row = loadStmt.get({ $id: id }) as TaskRow | null;
    return row !== null ? rowToTask(row) : undefined;
  }

  function remove(id: TaskId): void {
    removeStmt.run({ $id: id });
  }

  function loadPending(): readonly ScheduledTask[] {
    const rows = loadPendingStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  function updateStatus(
    id: TaskId,
    status: ScheduledTaskStatus,
    patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
  ): void {
    const existing = load(id);
    if (existing === undefined) {
      return;
    }
    const updated: ScheduledTask = {
      ...existing,
      status,
      ...(patch?.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch?.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch?.retries !== undefined ? { retries: patch.retries } : {}),
    };
    save(updated);
  }

  function query(filter: TaskFilter): readonly ScheduledTask[] {
    const conditions: string[] = [];
    const params: Record<string, string | number | boolean | null> = {};

    if (filter.status !== undefined) {
      conditions.push("status = $status");
      params.$status = filter.status;
    }
    if (filter.agentId !== undefined) {
      conditions.push("agent_id = $agent_id");
      params.$agent_id = filter.agentId;
    }
    if (filter.priority !== undefined) {
      conditions.push("priority = $priority");
      params.$priority = filter.priority;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter.limit !== undefined ? `LIMIT $limit` : "";
    if (filter.limit !== undefined) {
      params.$limit = filter.limit;
    }

    const sql = `SELECT * FROM koi_tasks ${where} ORDER BY priority ASC, created_at ASC ${limitClause}`;
    const stmt = db.prepare<TaskRow, SQLQueryBindings>(sql);
    const rows = stmt.all(params);
    return rows.map(rowToTask);
  }

  async function asyncDispose(): Promise<void> {
    db.close();
  }

  return {
    save,
    load,
    remove,
    updateStatus,
    query,
    loadPending,
    [Symbol.asyncDispose]: asyncDispose,
  };
}

// ---------------------------------------------------------------------------
// SqliteScheduleStore
// ---------------------------------------------------------------------------

export function createSqliteScheduleStore(db: Database): ScheduleStore {
  db.prepare(SCHEDULE_DDL).run();

  const saveStmt = db.prepare(`
    INSERT OR REPLACE INTO koi_schedules
      (id, expression, agent_id, input, mode, task_options, timezone, paused)
    VALUES ($id, $expression, $agent_id, $input, $mode, $task_options, $timezone, $paused)
  `);

  const removeStmt = db.prepare(`
    DELETE FROM koi_schedules WHERE id = $id
  `);

  const loadAllStmt = db.prepare(`
    SELECT * FROM koi_schedules
  `);

  function saveSchedule(schedule: CronSchedule): void {
    saveStmt.run({
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
    removeStmt.run({ $id: id });
  }

  function loadSchedules(): readonly CronSchedule[] {
    const rows = loadAllStmt.all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  async function asyncDispose(): Promise<void> {
    db.close();
  }

  return {
    saveSchedule,
    removeSchedule,
    loadSchedules,
    [Symbol.asyncDispose]: asyncDispose,
  };
}

// ---------------------------------------------------------------------------
// SqliteRunStore — task run history for audit
// ---------------------------------------------------------------------------

export interface RunStoreFilter {
  readonly agentId?: AgentId | undefined;
  readonly status?: "completed" | "failed" | undefined;
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
}

export interface RunStore extends AsyncDisposable {
  readonly saveRun: (run: TaskRunRecord) => void;
  readonly loadRuns: (taskId: TaskId) => readonly TaskRunRecord[];
  readonly queryRuns: (filter: RunStoreFilter) => readonly TaskRunRecord[];
}

export function createSqliteRunStore(db: Database): RunStore {
  db.prepare(RUN_DDL).run();

  const saveStmt = db.prepare(`
    INSERT INTO koi_task_runs
      (id, task_id, agent_id, status, started_at, completed_at, duration_ms,
       retry_attempt, error, result)
    VALUES ($id, $task_id, $agent_id, $status, $started_at, $completed_at,
            $duration_ms, $retry_attempt, $error, $result)
  `);

  const loadStmt = db.prepare(`
    SELECT * FROM koi_task_runs WHERE task_id = $task_id ORDER BY retry_attempt ASC
  `);

  function saveRun(run: TaskRunRecord): void {
    const id = `${run.taskId}:${run.retryAttempt}`;
    saveStmt.run({
      $id: id,
      $task_id: run.taskId,
      $agent_id: run.agentId,
      $status: run.status,
      $started_at: run.startedAt,
      $completed_at: run.completedAt,
      $duration_ms: run.durationMs,
      $retry_attempt: run.retryAttempt,
      $error: run.error ?? null,
      $result: run.result !== undefined ? JSON.stringify(run.result) : null,
    });
  }

  function loadRuns(id: TaskId): readonly TaskRunRecord[] {
    const rows = loadStmt.all({ $task_id: id }) as RunRow[];
    return rows.map(rowToRunRecord);
  }

  function queryRuns(filter: RunStoreFilter): readonly TaskRunRecord[] {
    const conditions: string[] = [];
    const params: Record<string, string | number | null> = {};

    if (filter.agentId !== undefined) {
      conditions.push("agent_id = $agent_id");
      params.$agent_id = filter.agentId;
    }
    if (filter.status !== undefined) {
      conditions.push("status = $status");
      params.$status = filter.status;
    }
    if (filter.since !== undefined) {
      conditions.push("started_at >= $since");
      params.$since = filter.since;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filter.limit !== undefined ? `LIMIT $limit` : "";
    if (filter.limit !== undefined) {
      params.$limit = filter.limit;
    }

    const sql = `SELECT * FROM koi_task_runs ${where} ORDER BY started_at DESC ${limitClause}`;
    const stmt = db.prepare<RunRow, SQLQueryBindings>(sql);
    const rows = stmt.all(params);
    return rows.map(rowToRunRecord);
  }

  async function asyncDispose(): Promise<void> {
    db.close();
  }

  return {
    saveRun,
    loadRuns,
    queryRuns,
    [Symbol.asyncDispose]: asyncDispose,
  };
}
