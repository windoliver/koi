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
// Factory
export function createScheduler(
  config: SchedulerConfig,
  store: TaskStore,
  clock?: Clock,
  scheduleStore?: ScheduleStore
): TaskScheduler

// Interfaces (defined in @koi/core)
interface TaskScheduler {
  submit(agentId: AgentId, input: string, opts?: TaskOptions): Promise<TaskId>
  cancel(taskId: TaskId, agentId: AgentId): Promise<boolean>
  schedule(agentId: AgentId, expression: string, input: string, opts?: ScheduleOptions): Promise<ScheduleId>
  unschedule(scheduleId: ScheduleId, agentId: AgentId): Promise<boolean>
  pause(scheduleId: ScheduleId, agentId: AgentId): Promise<boolean>
  resume(scheduleId: ScheduleId, agentId: AgentId): Promise<boolean>
  query(agentId: AgentId, filter?: TaskFilter): Promise<ScheduledTask[]>
  stats(): Promise<SchedulerStats>
  history(agentId: AgentId, filter?: HistoryFilter): Promise<TaskRunRecord[]>
  watch(listener: (event: SchedulerEvent) => void): () => void
  [Symbol.asyncDispose](): Promise<void>
}

interface TaskStore {
  save(task: ScheduledTask): Promise<void>
  load(taskId: TaskId): Promise<ScheduledTask | undefined>
  updateStatus(taskId: TaskId, status: TaskStatus, patch?: Partial<ScheduledTask>): Promise<void>
  query(filter: TaskFilter): Promise<ScheduledTask[]>
  loadPending(): Promise<ScheduledTask[]>
  remove(taskId: TaskId): Promise<void>
  purge(olderThanMs: number, statuses: TaskStatus[]): Promise<number>
}

interface ScheduleStore {
  saveSchedule(entry: ScheduleEntry): Promise<void>
  removeSchedule(scheduleId: ScheduleId): Promise<void>
  loadSchedules(): Promise<ScheduleEntry[]>
}
```

### SQLite Schema

```sql
CREATE TABLE koi_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  input TEXT NOT NULL,
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
  input TEXT NOT NULL,
  mode TEXT NOT NULL,
  task_options TEXT,
  timezone TEXT,
  paused INTEGER NOT NULL DEFAULT 0
);
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
  → croner fires → submit() → normal task lifecycle
  → ScheduleStore.save() for persistence across restart

init() on startup
  → TaskStore.loadPending() → rebuild heap
  → recover stale "running" tasks → mark failed
  → ScheduleStore.loadSchedules() → re-register croners
```

### SchedulerConfig

```typescript
interface SchedulerConfig {
  readonly pollIntervalMs: number        // default: 1000
  readonly maxConcurrent: number         // default: 5
  readonly defaultPriority: number       // default: 5
  readonly defaultMaxRetries: number     // default: 3
  readonly maxDeadLetterRetries: number  // default: 0
  readonly dbPath: string                // SQLite file path
  readonly dispatcher: TaskDispatcher    // (agentId, input, mode) => Promise<void>
}

type TaskDispatcher = (agentId: AgentId, input: string, mode: DispatchMode) => Promise<void>
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

All tools created by `attach(scheduler, agentId)`. The `agentId` is never in the LLM schema — pinned at attach time.

| Tool | Input | Output |
|------|-------|--------|
| `scheduler_submit` | `input`, `mode`, `priority?`, `delayMs?`, `maxRetries?`, `timeoutMs?` | `{ taskId }` |
| `scheduler_cancel` | `taskId` | `{ cancelled: boolean }` |
| `scheduler_schedule` | `expression`, `input`, `mode`, `timezone?`, `priority?`, `maxRetries?`, `timeoutMs?` | `{ scheduleId }` |
| `scheduler_unschedule` | `scheduleId` | `{ removed: boolean }` |
| `scheduler_pause` | `scheduleId` | `{ paused: boolean }` |
| `scheduler_resume` | `scheduleId` | `{ resumed: boolean }` |
| `scheduler_query` | `status?`, `priority?`, `limit?` (max 50, default 20) | `{ tasks, count }` |
| `scheduler_stats` | _(none)_ | `{ pending, running, completed, failed, deadLettered, activeSchedules, pausedSchedules }` |
| `scheduler_history` | `status?`, `since?`, `limit?` (max 50, default 20) | `{ runs, count }` |

### Security Model

- `agentId` pinned at `attach()` — never exposed in LLM schemas
- `query` and `history` auto-filter to owning agent's tasks
- `cancel` verifies task ownership before cancelling
- `unschedule`/`pause`/`resume` verify schedule ownership

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
| One-shot schedule fires once | `scheduler.test.ts` |
| Recurring task re-schedules | `scheduler.test.ts` |
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
