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

### Persist running state before dispatch

`dispatchTask` awaits `TaskStore.updateStatus(task.id, "running", { startedAt })`
before emitting `task:started` or invoking the `TaskDispatcher`. The store contract
allows async implementations, so persistence failures must stop dispatch rather than
letting a task execute while it is still durably recorded as `pending`.

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

## RunStoreFilter

`RunStoreFilter.status` accepts `"completed" | "failed" | "dead_letter"` — the `dead_letter`
value matches the `TaskHistoryFilter.status` in `@koi/core` so callers can query
dead-lettered runs directly via the store.

## Distributed mode (issue #1390)

`createScheduler` accepts an optional `{ queueBackend, nodeId }` parameter. When
present, the local heap-based polling loop is replaced by `pollDistributed()`,
which calls `queueBackend.claim(nodeId, available)` on each tick and dispatches
claimed tasks. On dispatch completion the scheduler calls
`queueBackend.ack(taskId)` (success) or `queueBackend.nack(taskId, reason)`
(failure). Cron-driven submissions are deduped across nodes via
`queueBackend.tick(scheduleId, nodeId)` — only the first node to claim a given
minute key dispatches the cron run.

Pair this with `@koi/scheduler-nexus` (Nexus-backed `TaskQueueBackend`) for
cross-node task scheduling, or implement `TaskQueueBackend` against any other
distributed store.
