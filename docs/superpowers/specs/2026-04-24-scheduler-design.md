# Scheduler Core + Provider — Design Spec

**Issue:** #1384 — v2 Phase 3-sched-1
**Date:** 2026-04-24
**Packages:** `@koi/scheduler` (L2 core), `@koi/scheduler-provider` (L2 provider)

---

## Overview

Two new L2 packages implementing cron-like scheduling, one-shot scheduling, recurring tasks, a task registry, and schedule persistence. Standalone — no Nexus dependency. Agents interact via 9 tools exposed by the provider.

---

## Architecture

### Packages

```
packages/sched/
├── scheduler/           @koi/scheduler          (L2 core)
└── scheduler-provider/  @koi/scheduler-provider  (L2 provider)
```

### Layer Compliance

- Both packages are L2: import from `@koi/core` (L0) and L0u utilities only
- No `@koi/engine`, no peer L2 imports, no Nexus dependency
- `@koi/scheduler-provider` depends on `@koi/scheduler`

---

## @koi/scheduler — Core

### Source Files

| File | Est. LOC | Purpose |
|------|----------|---------|
| `scheduler.ts` | ~550 | Core: priority heap, croner cron, retry, semaphore, events |
| `sqlite-store.ts` | ~388 | TaskStore + ScheduleStore SQLite implementation |
| `heap.ts` | ~114 | Generic min-heap priority queue |
| `clock.ts` | ~122 | Clock interface + SystemClock + FakeClock (test isolation) |
| `timer.ts` | ~81 | PeriodicTimer + AdaptiveTimer |
| `retry.ts` | ~17 | Exponential backoff formula |
| `semaphore.ts` | ~33 | Bounded concurrency counter |
| `index.ts` | ~20 | Public exports |

Total: ~1325 LOC

### Public API

```typescript
// Dispatcher contract — agentId, EngineInput, mode, AbortSignal.
// signal is aborted when timeoutMs elapses. Dispatchers SHOULD propagate it.
// Timeout policy: terminal. A timed-out task moves directly to dead_letter — it is
// NOT retried. This prevents duplicate execution of non-idempotent side effects.
// Dispatchers that cannot cooperatively cancel MUST document their work as idempotent,
// since the original dispatch may complete after the AbortSignal fires.
type TaskDispatcher = (
  agentId: AgentId,
  input: EngineInput,
  mode: "spawn" | "dispatch",
  signal: AbortSignal,
) => Promise<void>

// Factory — dbPath is separate (passed to createSqliteTaskStore / createSqliteScheduleStore)
export function createScheduler(
  config: SchedulerConfig,
  store: TaskStore,
  dispatcher: TaskDispatcher,
  clock?: Clock,
  scheduleStore?: ScheduleStore,
): TaskScheduler

// All interfaces below ARE already defined in @koi/core. Do NOT redefine them.
// Signatures here are copied verbatim from packages/kernel/core/src/scheduler.ts
// for reference only. Implementation MUST import from @koi/core.
//
// EngineInput (from @koi/core engine.ts) — stored as JSON in SQLite:
//   { kind: "text"; text: string }
//   | { kind: "messages"; messages: InboundMessage[] }
//   | { kind: "resume"; state: EngineState }

// TaskScheduler — full host-facing interface (exact L0 signatures):
interface TaskScheduler extends AsyncDisposable {
  // mode is required (no default)
  readonly submit: (agentId: AgentId, input: EngineInput, mode: "spawn" | "dispatch", options?: TaskOptions) => TaskId | Promise<TaskId>
  // cancel/unschedule/pause/resume take only an ID — no agentId (caller-side filter)
  readonly cancel: (id: TaskId) => boolean | Promise<boolean>
  // expression is FIRST in schedule()
  readonly schedule: (expression: string, agentId: AgentId, input: EngineInput, mode: "spawn" | "dispatch", options?: TaskOptions & { readonly timezone?: string }) => ScheduleId | Promise<ScheduleId>
  readonly unschedule: (id: ScheduleId) => boolean | Promise<boolean>
  readonly pause: (id: ScheduleId) => boolean | Promise<boolean>
  readonly resume: (id: ScheduleId) => boolean | Promise<boolean>
  // query/history take filter objects (agentId is a field inside, not positional)
  readonly query: (filter: TaskFilter) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>
  readonly stats: () => SchedulerStats            // global, host-process only
  readonly history: (filter: TaskHistoryFilter) => readonly TaskRunRecord[] | Promise<readonly TaskRunRecord[]>
  readonly watch: (listener: (event: SchedulerEvent) => void) => () => void
}

// SchedulerComponent — agent-facing subset (exact L0 signatures, agentId pinned):
interface SchedulerComponent {
  readonly submit: (input: EngineInput, mode: "spawn" | "dispatch", options?: TaskOptions) => TaskId | Promise<TaskId>
  readonly cancel: (id: TaskId) => boolean | Promise<boolean>
  readonly schedule: (expression: string, input: EngineInput, mode: "spawn" | "dispatch", options?: TaskOptions & { readonly timezone?: string }) => ScheduleId | Promise<ScheduleId>
  readonly unschedule: (id: ScheduleId) => boolean | Promise<boolean>
  readonly pause: (id: ScheduleId) => boolean | Promise<boolean>
  readonly resume: (id: ScheduleId) => boolean | Promise<boolean>
  readonly query: (filter: TaskFilter) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>
  readonly stats: () => SchedulerStats | Promise<SchedulerStats>   // MUST be agent-scoped in impl
  readonly history: (filter: TaskHistoryFilter) => readonly TaskRunRecord[] | Promise<readonly TaskRunRecord[]>
}

// TaskStore — exact L0 signatures (no purge — not in L0 contract):
interface TaskStore extends AsyncDisposable {
  readonly save: (task: ScheduledTask) => void | Promise<void>
  readonly load: (id: TaskId) => ScheduledTask | undefined | Promise<ScheduledTask | undefined>
  readonly remove: (id: TaskId) => void | Promise<void>
  readonly updateStatus: (id: TaskId, status: ScheduledTaskStatus, patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>) => void | Promise<void>
  readonly query: (filter: TaskFilter) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>
  readonly loadPending: () => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>
}

// ScheduleStore — exact L0 signatures (uses CronSchedule, not ScheduleEntry):
interface ScheduleStore extends AsyncDisposable {
  readonly saveSchedule: (schedule: CronSchedule) => void | Promise<void>
  readonly removeSchedule: (id: ScheduleId) => void | Promise<void>
  readonly loadSchedules: () => readonly CronSchedule[] | Promise<readonly CronSchedule[]>
  // updateSchedule used by pause/resume to persist the paused flag before returning.
  // Durability requirement: pause() and resume() MUST call updateSchedule() and await
  // persistence before mutating in-memory croner state or returning to the caller.
  // A process restart must reproduce the paused/active state from the store, not memory.
  readonly updateSchedule: (id: ScheduleId, patch: Partial<Pick<CronSchedule, "paused" | "last_run_at">>) => void | Promise<void>
}

// SchedulerConfig — exact L0 definition (no dbPath — passed to SQLite store factory separately):
interface SchedulerConfig {
  readonly maxConcurrent: number           // default: 10
  readonly defaultPriority: number         // default: 5
  readonly defaultMaxRetries: number       // default: 3
  readonly baseRetryDelayMs: number        // default: 1_000
  readonly maxRetryDelayMs: number         // default: 60_000
  readonly retryJitterMs: number           // default: 500
  readonly pollIntervalMs: number          // default: 1_000
  readonly staleTaskThresholdMs: number    // default: 300_000 (stale "running" recovery)
}
```

### SQLite Schema

```sql
-- input column stores JSON-serialized EngineInput (kind + variant fields)
-- e.g. {"kind":"text","text":"run daily report"}
-- Deserialization must validate the discriminant and reject unknown kinds.
CREATE TABLE koi_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  input TEXT NOT NULL,   -- JSON: EngineInput discriminated union
  mode TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER,
  last_error TEXT,
  metadata TEXT
);

CREATE TABLE koi_schedules (
  id TEXT PRIMARY KEY,
  expression TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  input TEXT NOT NULL,   -- JSON: EngineInput discriminated union
  mode TEXT NOT NULL,
  task_options TEXT,
  timezone TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER    -- Unix ms: last fire time (null = never fired); updated after each tick
);
-- Restart semantics:
-- On startup, all non-paused schedules are re-registered with croner.
-- Missed recurring runs during downtime are skipped by default (no backfill).
-- One-shot execution is modeled as submit() with delayMs, NOT as a schedule row.
-- koi_schedules only stores recurring cron schedules.

-- Immutable append-only run history: one row per execution attempt.
-- Never updated. Rows keyed by (task_id, retry_attempt).
-- Supports TaskRunRecord[] returned by history() and scheduler_history tool.
-- No foreign key cascade: run history must survive task row deletion.
-- Task rows may be removed (cancelled, cleaned up); run history is retained independently.
CREATE TABLE koi_task_runs (
  id TEXT PRIMARY KEY,            -- unique run ID (branded RunId)
  task_id TEXT NOT NULL,          -- no CASCADE: history is independent of task lifecycle
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- "completed" | "failed"
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  retry_attempt INTEGER NOT NULL,
  error TEXT,                     -- JSON: KoiError | null
  result TEXT,                    -- JSON: unknown | null
  UNIQUE(task_id, retry_attempt)  -- enforces one row per attempt; INSERT fails loudly on conflict
);
-- Duplicate-execution policy: since timeout is terminal (dead_letter, no retry),
-- and stale-task recovery increments retries++ (new attempt number), legitimate
-- duplicate inserts for the same (task_id, retry_attempt) should not occur.
-- If a conflict arises, fail loudly (do NOT use INSERT OR IGNORE) — it signals a logic bug.
```

### Task Lifecycle

```
submit(input, mode, opts)
  → createTask() → TaskStore.save() → heap.insert()
  → poll() picks up (scheduledAt ≤ now, semaphore slot free)
  → dispatchTask(agentId, input, mode)
  → on success: updateStatus("completed")
  → on failure: retry with backoff OR dead-letter after maxRetries

schedule(expression, input, mode, opts)
  → validateCronExpression(expression) — reject invalid expressions early
  → ScheduleStore.saveSchedule(entry) — persist FIRST before any in-memory state
  → register croner in-memory
  → return scheduleId (caller can trust persistence)
  → on croner tick: submit() → normal task lifecycle

  Durability invariant: if ScheduleStore.save fails, the whole call fails and
  no in-memory croner is registered. scheduleId is never returned for
  unpersisted schedules.

init() on startup
  → TaskStore.loadPending() → rebuild heap (all pending + delayed tasks)
  → stale "running" recovery: tasks where startedAt < (now - staleTaskThresholdMs)
      are moved back to pending with retries++ — these are tasks interrupted by
      process crash, NOT by timeout (timed-out tasks are already dead_letter before restart)
      (staleTaskThresholdMs default: 300_000ms — from SchedulerConfig in @koi/core)
      tasks exceeding maxRetries are dead-lettered instead of re-queued
      emit task:recovered event for each recovered task
  → ScheduleStore.loadSchedules() → re-register croners for non-paused schedules

timeout enforcement
  → dispatchTask() creates AbortController, wraps dispatcher call in Promise.race([
        dispatcher(agentId, input, mode, signal),
        sleep(timeoutMs).then(() => { controller.abort(); throw new TimeoutError() })
      ])
  → semaphore is always released in a finally block — no stuck slots
  → on timeout: timeout is treated as TERMINAL — task moves directly to dead_letter,
      NOT retried. Automatic retry of timed-out work is disabled because a
      non-cooperative dispatcher may still be running, and re-queuing would produce
      duplicate execution of potentially non-idempotent side effects.
      emit task:dead_letter with error reason="timeout"
  → callers who need timeout-with-retry must configure a longer timeoutMs or split
      work into idempotent units.
```

### SchedulerConfig and TaskDispatcher

`SchedulerConfig` is defined in `@koi/core` — import it, do not redeclare. See exact definition above in the Public API section. Default values are in `DEFAULT_SCHEDULER_CONFIG` from `@koi/core`.

`TaskDispatcher` is NOT in `@koi/core` — it is a local type defined in `@koi/scheduler`:

```typescript
// signal is aborted when timeoutMs elapses; dispatcher SHOULD propagate it to cancel
// in-flight work. A timed-out task moves to dead_letter immediately — it is NOT retried.
// Dispatchers that cannot cooperatively cancel MUST treat their work as idempotent,
// since the original dispatch may complete after the scheduler has moved on.
type TaskDispatcher = (
  agentId: AgentId,
  input: EngineInput,
  mode: "spawn" | "dispatch",
  signal: AbortSignal,
) => Promise<void>
```

`dbPath` is passed to `createSqliteTaskStore(dbPath)` and `createSqliteScheduleStore(dbPath)` separately, not via `SchedulerConfig`.
```

### What's Stripped vs V1

| V1 feature | V2 decision |
|------------|-------------|
| `queueBackend?: TaskQueueBackend` | **Removed** — no Nexus, local-only |
| `distributedPoll()` | **Removed** |
| `nodeId?: string` param | **Removed** |
| `descriptor.ts` (manifest integration) | **Removed** — separate concern |
| `stats-mapping.ts` (ProcessState bridge) | **Removed** — separate concern |

---

## @koi/scheduler-provider — Provider

### Source Files

| File | Est. LOC | Purpose |
|------|----------|---------|
| `provider.ts` | ~80 | `attach(scheduler, agentId)` → `KoiTool[]` |
| `tools/submit.ts` | ~40 | scheduler_submit tool |
| `tools/cancel.ts` | ~30 | scheduler_cancel tool |
| `tools/schedule.ts` | ~50 | scheduler_schedule tool |
| `tools/unschedule.ts` | ~30 | scheduler_unschedule tool |
| `tools/pause.ts` | ~30 | scheduler_pause tool |
| `tools/resume.ts` | ~30 | scheduler_resume tool |
| `tools/query.ts` | ~40 | scheduler_query tool |
| `tools/stats.ts` | ~25 | scheduler_stats tool |
| `tools/history.ts` | ~40 | scheduler_history tool |
| `skill.ts` | ~50 | Skill markdown for agent guidance |
| `index.ts` | ~15 | Public exports |

Total: ~460 LOC

### Tool Surface (9 tools)

All tools created by `attach(component: SchedulerComponent)`. The provider receives a `SchedulerComponent` — the agent-scoped L0 interface — not the raw `TaskScheduler`. Ownership enforcement (cancel/unschedule/pause/resume only affect the attached agent's work) is built into the `SchedulerComponent` implementation in `@koi/scheduler`, not re-implemented in the provider. The `agentId` is pinned inside `SchedulerComponent` at construction time and is never in the LLM tool schemas.

| Tool | Input | Output |
|------|-------|--------|
| `scheduler_submit` | `input`, `mode`, `priority?`, `delayMs?`, `maxRetries?`, `timeoutMs?` | `{ taskId }` |
| `scheduler_cancel` | `taskId` | `{ cancelled: boolean }` |
| `scheduler_schedule` | `expression`, `input`, `mode`, `timezone?`, `priority?`, `maxRetries?`, `timeoutMs?` | `{ scheduleId }` |
| `scheduler_unschedule` | `scheduleId` | `{ removed: boolean }` |
| `scheduler_pause` | `scheduleId` | `{ paused: boolean }` |
| `scheduler_resume` | `scheduleId` | `{ resumed: boolean }` |
| `scheduler_query` | `status?`, `priority?`, `limit?` (max 50, default 20) | `{ tasks, count }` |
| `scheduler_stats` | _(none)_ | `{ pending, running, completed, failed, deadLettered, activeSchedules, pausedSchedules }` — all counts are agent-scoped: task counts from `query({agentId})` by status; schedule counts from `ScheduleStore.loadSchedules()` filtered by agentId in the impl |
| `scheduler_history` | `status?`, `since?`, `limit?` (max 50, default 20) | `{ runs, count }` |

### Security Model

- `agentId` pinned inside `SchedulerComponent` at construction — never exposed in LLM schemas
- Ownership enforcement lives in `SchedulerComponent` impl: `cancel`, `unschedule`, `pause`, `resume` verify the target belongs to the pinned agentId before mutating (using `TaskStore.load()` and `ScheduleStore.loadSchedules()` accessible to the scheduler)
- `query`, `history`, `stats` pass `{ agentId }` in all filters — no cross-agent data reachable through the component interface
- `scheduler_stats` derives agent-scoped counts: task counts via `query({ agentId, status })` enumerated by status; schedule counts via schedule store filtered by agentId
- Global `TaskScheduler.stats()` is host-process only — not exposed through any agent tool

---

## Error Handling

- **Expected failures** (not-found, ownership violation, invalid cron): return typed discriminated union `{ ok: false, error: KoiError }`
- **Unexpected failures** (SQLite I/O, croner crash): throw with ES2022 `{ cause: err }` chaining
- Dead-letter is terminal — tasks exhaust retries, emit `task:dead_letter` event, no silent swallowing
- `catch (e: unknown)` everywhere — never bare `catch (e)`

---

## Testing

**Strategy:** FakeClock for all time-dependent tests; in-memory TaskStore stub for unit tests; real SQLite for integration.

**Required test cases (from issue #1384):**

| Test | File |
|------|------|
| Cron schedule fires at correct time | `scheduler.test.ts` |
| One-shot schedule fires once (submit with delayMs) | `scheduler.test.ts` |
| Recurring task re-schedules | `scheduler.test.ts` |
| Paused schedule stays paused after restart (SQLite round-trip) | `sqlite-store.test.ts` |
| Task registry tracks active schedules | `scheduler.test.ts` |
| Schedule persists across restart (SQLite round-trip) | `sqlite-store.test.ts` |
| Invalid cron expression rejected | `scheduler.test.ts` |
| Concurrent schedule modifications safe | `scheduler.test.ts` |

Additional: retry backoff, dead-letter promotion, semaphore bounding, heap ordering, clock abstraction, ownership enforcement in provider tools.

**Coverage target:** ≥80% lines, functions, statements (enforced by `bunfig.toml`).

---

## Dependencies

| Package | Justification |
|---------|--------------|
| `croner` | Cron expression parsing + next-fire-time. Stable, well-maintained. Cannot justify 300+ LOC hand-rolled parser. |
| `bun:sqlite` | Built-in — zero dependency cost |

No other external dependencies.

---

## CI Gates

```bash
bun run test --filter=@koi/scheduler
bun run test --filter=@koi/scheduler-provider
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
```
