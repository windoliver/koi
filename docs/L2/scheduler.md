# @koi/scheduler

In-process task scheduler with SQLite persistence — delayed dispatch, cron schedules, retry with backoff, dead-letter queue, and observable events.

## Layer

L2 — depends on `@koi/core` (L0) only. Zero peer L2 dependencies.

## Purpose

Provides `createScheduler()`, the runtime that queues, delays, and retries agent task
dispatches. The scheduler owns the lifecycle of a `ScheduledTask` from submission through
completion (or dead-letter), and drives cron schedules as recurring task factories.

Also exports:
- `createSqliteTaskStore` / `createSqliteRunStore` / `createSqliteScheduleStore` — SQLite-backed
  persistence for tasks, run history, and cron schedules respectively
- `createSchedulerComponent` — wraps a `TaskScheduler` + `AgentId` into the `SchedulerComponent`
  ECS singleton for agent assembly
- `createFakeClock` — deterministic test clock (not re-exported from index; import from
  `@koi/scheduler/src/clock` for tests)

## Key Design Decisions

### Clock abstraction for testability

All time-dependent logic (poll interval, delay expiry, retry backoff) goes through a `Clock`
interface. Production uses `globalThis.setTimeout`. Tests inject `createFakeClock()` to
advance virtual time without sleeping, making timing tests fast and deterministic.

### Polling over timer-per-task

A single poll loop fires every `pollIntervalMs` (default 1 s) and selects all tasks whose
`runAt <= now`. This avoids one timer handle per pending task (O(1) timer overhead
regardless of queue depth) and makes SQLite the source of truth for task state.

A min-heap (`createMinHeap`) shadows the SQLite state in memory for early-exit: if the
nearest scheduled task is still in the future, the poll callback skips the DB query.

### Retry with exponential backoff + jitter

On dispatcher failure the task transitions to `pending` with `runAt = now + delay` where
delay follows `baseRetryDelayMs * 2^attempt + jitter`. After `maxRetries` exhausted the
task moves to `dead_letter` and a `task:dead_letter` event fires.

### Cron schedules

`scheduler.schedule(expr, agentId, input, mode)` registers a cron expression parsed at
registration time (invalid expressions throw synchronously). Each poll tick computes the
next fire time for every unpaused schedule and submits a one-shot task when past due.
Pause/resume/unschedule all operate on the `ScheduleStore` and survive dispose+recreate
from the same `Database` instance.

### TaskDispatcher is not in `@koi/core`

`TaskDispatcher` is defined locally in `packages/sched/scheduler/src/types.ts`. It is an
L2 implementation detail — callers provide a function that bridges from the scheduler into
whatever agent spawning mechanism the host provides. Keeping it out of L0 avoids coupling
the core type system to spawning semantics.

### Run history

`createSqliteRunStore` records every dispatch attempt (start time, duration, error, result)
keyed by `(taskId, retryAttempt)` with `INSERT OR REPLACE` semantics so a retry can
overwrite the prior attempt record when the task ID is reused.

## Public API

```typescript
// Factory
createScheduler(
  config: SchedulerConfig,
  store: TaskStore,
  dispatcher: TaskDispatcher,
  clock?: Clock,
  scheduleStore?: ScheduleStore,
  runStore?: RunStore,
): TaskScheduler

// ECS adapter
createSchedulerComponent(scheduler: TaskScheduler, agentId: AgentId): SchedulerComponent

// SQLite stores
createSqliteTaskStore(db: Database): TaskStore
createSqliteRunStore(db: Database): RunStore
createSqliteScheduleStore(db: Database): ScheduleStore
```

## Configuration (`SchedulerConfig` / `DEFAULT_SCHEDULER_CONFIG` in `@koi/core`)

| Field | Default | Description |
|-------|---------|-------------|
| `pollIntervalMs` | 1000 | How often the poll loop fires |
| `baseRetryDelayMs` | 1000 | Base delay before first retry |
| `maxRetryDelayMs` | 30000 | Retry delay cap |
| `retryJitterMs` | 500 | Random jitter added to retry delay |
| `taskTimeoutMs` | 300000 | Dispatcher timeout (AbortSignal) |
| `maxConcurrent` | 10 | Max simultaneous in-flight dispatches |

## Testing

Tests use `createFakeClock` to eliminate real timers. The `clock.tick(ms)` method
advances virtual time and triggers due timeouts synchronously. Real async work (DB
writes, dispatcher calls) is awaited with `new Promise(r => globalThis.setTimeout(r, N))`
to let the microtask queue drain before asserting outcomes.

All stores (`TaskStore`, `RunStore`, `ScheduleStore`) are backed by `:memory:` SQLite
databases in tests so there is no disk I/O and each test gets a fresh schema.
