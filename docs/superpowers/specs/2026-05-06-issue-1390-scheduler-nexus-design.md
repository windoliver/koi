# Design: `@koi/scheduler-nexus` + `@koi/harness-scheduler` — Nexus + Harness Integration

**Date:** 2026-05-06
**Issue:** [#1390](https://github.com/windoliver/koi/issues/1390)
**Approach:** A — Port v1 packages into v2 and adapt the wiring to current scheduler contracts

---

## Overview

Adds two missing L2 scheduler packages to the active v2 tree:

- `@koi/scheduler-nexus` — Nexus-backed `TaskStore`, `ScheduleStore`, and `TaskQueueBackend`
- `@koi/harness-scheduler` — poll-based harness auto-resume with backoff and failure handling

The existing `@koi/scheduler` package remains the orchestration layer. The new Nexus package plugs in beneath it through the existing L0 contracts from `packages/kernel/core/src/scheduler.ts`, so local SQLite scheduling remains the standalone default and Nexus becomes an optional distributed backend.

This issue also requires integration work:

- wire the CLI/runtime scheduler preset to choose local or Nexus-backed backends
- expose scheduler tools through the harness-facing CLI path
- provide a schedule migration path from local SQLite persistence to Nexus persistence
- guarantee that missing or invalid Nexus configuration falls back to the current local scheduler path

---

## Package Structure

### New packages

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/scheduler-nexus` | L2 | Distributed scheduler backends backed by Nexus |
| `@koi/harness-scheduler` | L2 | Auto-resume loop for suspended harnesses |

### Existing packages modified

| Package | Reason |
|---------|--------|
| `@koi/scheduler` | Confirm distributed queue hooks remain sufficient for Nexus-backed execution and migration |
| `@koi/scheduler-provider` | No API changes expected; verify compatibility with distributed scheduler path |
| `packages/meta/cli` | Wire local-vs-Nexus backend selection and harness-facing scheduler exposure |
| `@koi/nexus-client` | Consumed by `@koi/scheduler-nexus`; no interface changes expected |

### Directory layout

```text
packages/sched/
├── scheduler/                existing local scheduler orchestration
├── scheduler-provider/       existing 9-tool provider surface
├── scheduler-nexus/          new Nexus-backed stores + queue backend
└── harness-scheduler/        new harness auto-resume loop
```

---

## Architecture

### 1. `@koi/scheduler` stays in charge

`@koi/scheduler` already supports:

- `TaskStore`
- `ScheduleStore`
- `TaskQueueBackend`
- optional distributed queue methods: `claim`, `ack`, `nack`, `tick`

That means distributed scheduling does not require a second scheduler implementation. Instead, the Nexus package supplies concrete backends and the existing scheduler loop uses them.

### 2. `@koi/scheduler-nexus` provides three backends

The ported package will implement the current L0 contracts:

```typescript
export interface NexusSchedulerBackends {
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
  readonly queueBackend: TaskQueueBackend;
}

export interface NexusSchedulerConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly namespace?: string | undefined;
  readonly nodeId: string;
  readonly visibilityTimeoutMs: number;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface NexusQueueConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly namespace?: string | undefined;
  readonly nodeId: string;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export function createNexusTaskStore(config: NexusQueueConfig): TaskStore;
export function createNexusScheduleStore(config: NexusQueueConfig): ScheduleStore;
export function createNexusTaskQueue(config: NexusSchedulerConfig): TaskQueueBackend;
export function createNexusSchedulerBackends(
  config: NexusSchedulerConfig,
): NexusSchedulerBackends;
```

The composite factory shares a single Nexus client/transport instance across all three backends, matching the current docs and avoiding redundant connection setup.

### 3. `@koi/harness-scheduler` stays independent of scheduler backend choice

`@koi/harness-scheduler` is not a distributed scheduler. It is a local control loop that watches a harness and calls `resume()` when appropriate.

It should remain structurally typed against a minimal `SchedulableHarness` interface rather than importing a specific higher-layer harness implementation. That preserves the L2 boundary and keeps it usable from CLI/runtime tests without tight coupling.

---

## `@koi/scheduler-nexus`

### Responsibilities

- persist tasks in Nexus instead of SQLite
- persist cron schedules in Nexus instead of SQLite
- provide a distributed priority queue with visibility-timeout claim semantics
- deduplicate cron ticks across nodes
- support at-least-once delivery across multiple scheduler processes

### v1 port strategy

Port these v1 source files as the starting point:

- `archive/v1/packages/sched/scheduler-nexus/src/nexus-task-store.ts`
- `archive/v1/packages/sched/scheduler-nexus/src/nexus-schedule-store.ts`
- `archive/v1/packages/sched/scheduler-nexus/src/nexus-queue.ts`
- `archive/v1/packages/sched/scheduler-nexus/src/nexus-scheduler.ts`
- `archive/v1/packages/sched/scheduler-nexus/src/config.ts`
- `archive/v1/packages/sched/scheduler-nexus/src/scheduler-config.ts`

Adaptations required for v2:

1. Import current L0 types from `@koi/core`
2. Reconcile any shape drift in `TaskOptions`, `CronSchedule`, and `TaskQueueBackend`
3. Use `@koi/nexus-client` as the transport layer instead of any archived inline transport logic
4. Keep exports aligned with the current docs in `docs/L2/scheduler-nexus.md` and `docs/L3/nexus.md`
5. Preserve local-first caller semantics by keeping all fallback logic out of the backend package itself

### Data model

The backends store the same logical objects already used by the local scheduler:

- `ScheduledTask`
- `CronSchedule`
- queue claim state
- run/ack/nack status transitions

No new scheduler-specific public types should be introduced if the current L0 shapes are sufficient.

### Cross-node semantics

#### Queue claim flow

```text
submit()
  -> TaskStore.save(task)
  -> queueBackend.enqueue(task)

poll loop on Node A / Node B
  -> queueBackend.claim(nodeId, limit)
  -> claimed task becomes invisible for visibilityTimeoutMs
  -> dispatcher runs task
  -> queueBackend.ack(taskId) on success
  -> queueBackend.nack(taskId, reason) on retryable failure
```

#### Cron tick dedupe

```text
cron schedule fires on each node
  -> queueBackend.tick(scheduleId, nodeId)
  -> only one node receives true
  -> winner submits actual task
```

This preserves the existing scheduler API while making recurring work single-fire across the cluster.

### Validation and configuration

The package keeps the v1-style config validation surface, adapted to current naming:

- `validateNexusSchedulerConfig(raw)`
- `validateNexusQueueConfig(raw)` if still useful after port

Validation failures are explicit and do not silently create a partial Nexus backend. Fallback happens at the integration layer, not inside the backend constructors.

---

## `@koi/harness-scheduler`

### Responsibilities

- poll a harness for its current phase/status
- call `resume()` when the harness is suspended
- apply exponential backoff with jitter on resume failure
- stop cleanly on `AbortSignal` or explicit disposal
- expose terminal `"failed"` behavior after max retries are exhausted

### Public API

The v1 API shape is already appropriate and should be preserved unless current L0/L2 naming forces a small adjustment:

```typescript
export interface SchedulableHarness {
  readonly status: () => HarnessStatus | Promise<HarnessStatus>;
  readonly resume: () => Promise<void>;
}

export interface HarnessSchedulerConfig {
  readonly harness: SchedulableHarness;
  readonly pollIntervalMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly maxRetryDelayMs?: number | undefined;
  readonly retryJitterMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface HarnessScheduler extends AsyncDisposable {
  readonly start: () => void;
  readonly stop: () => void;
  readonly phase: () => "idle" | "running" | "stopped" | "failed";
}

export function createHarnessScheduler(
  config: HarnessSchedulerConfig,
): HarnessScheduler;
```

Exact naming can follow the v1 source as long as it stays consistent with the docs in `docs/L2/harness-scheduler.md`.

### v2 adaptation constraints

- no imports from higher-layer harness packages
- no direct dependency on `@koi/scheduler-nexus`
- no special Nexus logic

This package is purely the missing orchestration glue between a resumable harness and any runtime that wants automatic resume behavior.

---

## CLI and Runtime Integration

### Current state

`packages/meta/cli/src/preset-stacks/scheduler.ts` currently always creates:

- in-memory SQLite `Database(":memory:")`
- `createSqliteTaskStore(db)`
- `createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {})`

That means the current preset has no schedule persistence store, no Nexus path, and no migration hook.

### Target state

The scheduler preset becomes a thin factory chooser:

1. Resolve host/runtime scheduler configuration
2. If Nexus scheduler config is present and valid:
   - construct `createNexusSchedulerBackends(...)`
   - construct `createScheduler(..., taskStore, dispatcher, clock, scheduleStore, queueBackend)`
3. Otherwise:
   - construct local SQLite stores and current local scheduler
4. Wrap in `createSchedulerComponent(...)`
5. Expose the same 9 scheduler tools through `createSchedulerProvider(...)`

### Integration boundary

The preset owns:

- backend selection
- fallback decisions
- migration trigger point

The backend packages own:

- backend correctness
- config validation
- distributed queue semantics

This keeps fallback logic centralized and visible to operators.

### Harness-facing CLI integration

The harness test CLI flow called out by the issue should expose scheduler tools and automatic resume behavior through the same preset stack ecosystem rather than inventing a second integration path.

That means:

- the harness path should activate `schedulerStack` when requested
- the harness runtime should be able to instantiate `createHarnessScheduler(...)`
- tests should prove the harness-facing CLI path exposes scheduler tools and can auto-resume suspended work

---

## Local Fallback Rules

Fallback is required behavior, not a best-effort optimization.

### When to fall back

- Nexus scheduler config missing
- Nexus scheduler config invalid
- Nexus client construction fails
- explicit operator choice to disable Nexus scheduler

### When not to fall back silently

- one-time migration has already started and writes partially fail
- operator explicitly requested Nexus-only behavior

In those cases the integration layer should return a clear error rather than risk split-brain state.

### Startup behavior

```text
resolve scheduler config
  -> no Nexus config
     -> local SQLite scheduler
  -> invalid Nexus config
     -> local SQLite scheduler + warning/diagnostic
  -> valid Nexus config
     -> optional migration
     -> Nexus-backed scheduler
```

The key invariant is that a machine without Nexus still boots and provides a fully functional local scheduler.

---

## Schedule Migration

### Goal

Move persisted local schedules and pending tasks from the existing SQLite scheduler persistence into Nexus-backed stores without duplicating work.

### Scope

Migration covers:

- cron schedules from local `ScheduleStore`
- pending/delayed tasks from local `TaskStore`

Migration does not attempt live in-flight handoff for already-running tasks. Running tasks remain local process concerns; only durable pending state is moved.

### Migration shape

Use an explicit bootstrap helper at the integration layer:

```typescript
export interface SchedulerMigrationReport {
  readonly schedulesImported: number;
  readonly tasksImported: number;
  readonly skippedExistingSchedules: number;
  readonly skippedExistingTasks: number;
}

export async function migrateLocalSchedulerToNexus(args: {
  readonly localTaskStore: TaskStore;
  readonly localScheduleStore: ScheduleStore;
  readonly nexusTaskStore: TaskStore;
  readonly nexusScheduleStore: ScheduleStore;
  readonly nexusQueueBackend: TaskQueueBackend;
}): Promise<SchedulerMigrationReport>;
```

### Migration rules

1. Read all local schedules from SQLite
2. Upsert them into Nexus schedule storage
3. Read all local pending tasks
4. Save them into Nexus task storage
5. Enqueue pending tasks into the Nexus queue if not already present
6. Skip duplicates by task ID / schedule ID rather than creating copies
7. Only mark migration successful after all writes complete

### Safety rules

- migration must be idempotent
- migration must not delete the local source data during the first pass
- if Nexus write fails mid-run, report failure and keep local scheduler path active
- migration should run before the process commits to Nexus-backed execution for that session

This gives operators a rollback-safe migration path and avoids partial cutovers.

---

## Testing

The acceptance tests map directly to the issue text.

### `@koi/scheduler-nexus`

| Test | What it proves |
|------|---------------|
| two scheduler instances distribute claimed tasks across nodes | distributed scheduling works |
| `claim` visibility timeout allows recovery after missed ack | cross-node recovery works |
| `tick(scheduleId, nodeId)` returns true for only one node | cron dedupe works |
| `createNexusSchedulerBackends()` returns compatible `TaskStore` / `ScheduleStore` / `TaskQueueBackend` | v2 contract alignment |
| config validator rejects incomplete Nexus config | no partial backend creation |

### `@koi/harness-scheduler`

| Test | What it proves |
|------|---------------|
| suspended harness is resumed on poll | basic auto-resume works |
| repeated resume failures back off and eventually fail terminally | retry/backoff behavior works |
| `dispose()` or abort stops polling | no timer leak |
| already-running harness is not resumed again | no duplicate resumes |

### CLI / preset integration

| Test | What it proves |
|------|---------------|
| scheduler preset exposes the 9 scheduler tools in local mode | local path unchanged |
| scheduler preset constructs Nexus backends when config is present | Nexus path wired |
| invalid/missing Nexus config falls back to local scheduler path | fallback works |
| harness-facing CLI path exposes scheduler tools | harness integration present |

### Migration tests

| Test | What it proves |
|------|---------------|
| local schedules import into Nexus unchanged | schedule migration preserves schedules |
| local pending tasks import into Nexus queue/store unchanged | task migration preserves pending work |
| rerunning migration skips already-imported IDs | migration is idempotent |
| migration failure leaves local scheduler active | no partial cutover |

### Test style

- `bun:test` for package-level tests
- fake Nexus transport/fetch handlers where possible
- two-instance integration tests for distributed behavior
- no real external Nexus dependency in unit tests

---

## File Plan

### `packages/sched/scheduler-nexus/`

```text
src/
  index.ts
  config.ts
  scheduler-config.ts
  descriptor.ts
  nexus-task-store.ts
  nexus-schedule-store.ts
  nexus-queue.ts
  nexus-scheduler.ts
  config.test.ts
  scheduler-config.test.ts
  nexus-task-store.test.ts
  nexus-schedule-store.test.ts
  nexus-queue.test.ts
  nexus-distributed.test.ts
package.json
tsconfig.json
tsup.config.ts
```

### `packages/sched/harness-scheduler/`

```text
src/
  index.ts
  scheduler.ts
  types.ts
  scheduler.test.ts
  __tests__/api-surface.test.ts
package.json
tsconfig.json
tsup.config.ts
```

### Integration touch points

- `packages/meta/cli/src/preset-stacks/scheduler.ts`
- any harness-facing preset/CLI activation files that currently own autonomous or long-running setup
- docs and package coverage metadata that already mention these packages but point to missing implementations

---

## Risks and Non-Goals

### Risks

- the active `createScheduler(...)` signature or queue integration may have drifted slightly from the archived v1 package expectations
- migration logic can accidentally duplicate pending tasks if enqueue idempotency is not handled carefully
- harness integration may span more than one CLI entrypoint if autonomous flows are split across presets

### Non-goals

- redesigning the scheduler L0 contracts
- rewriting the distributed package from scratch
- introducing Nexus as a hard dependency for scheduler usage
- live migration of already-running tasks between nodes

---

## Recommended Implementation Order

1. Port `@koi/harness-scheduler` with tests
2. Port `@koi/scheduler-nexus` stores and queue with tests
3. Wire CLI/runtime scheduler preset selection and fallback
4. Add migration helper and migration tests
5. Add harness-facing CLI integration tests

This order keeps the backends testable before the integration layer depends on them.
